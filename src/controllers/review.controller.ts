/**
 * 控制 review 相关 HTTP 路由的注册与请求处理。
 *
 * 这个文件负责把健康检查、GitLab webhook、CI 主动触发 review
 * 这几类入口统一挂到 Fastify，并把请求转换成内部 review 流程可消费的参数。
 */
import { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { config } from '../config/index.js';
import { ReviewCoordinator } from '../core/pipeline/review-coordinator.js';
import { ReviewPipeline } from '../core/pipeline/review-pipeline.js';
import { logger } from '../shared/logger.js';
import { ISCMProvider, ReviewProgressEvent, ReviewRunResult, ReviewTarget } from '../types/index.js';
import { dashboardScript, dashboardStyles, renderDashboardPage } from '../ui/dashboard.js';

/**
 * 控制器注册时由入口层注入的依赖。
 *
 * - `createScmProvider` 按当前配置创建 GitHub 或 GitLab provider
 * - `reviewCoordinator` 负责同一 review 目标的串行化与去重
 */
interface RegisterReviewControllerOptions {
  createScmProvider: () => ISCMProvider;
  reviewCoordinator: ReviewCoordinator;
}

/**
 * 流式返回给前端时使用的轻量进度统计。
 *
 * 这组字段不会替代 pipeline 的原始进度事件，只是把它们统一压成
 * 前端更容易展示的百分比模型。
 */
interface StreamProgressMetrics {
  current?: number;
  total?: number;
  percent?: number;
}

/**
 * 维护一次 NDJSON 流在控制器侧的临时状态。
 *
 * 由于 pipeline 的不同阶段并不会始终携带完整进度信息，
 * 这里会把“已完成文件数 / 总文件数 / 当前文件”缓存下来，
 * 供 heartbeat 和后续事件复用。
 */
interface StreamProgressState {
  completedFiles: number;
  totalFiles: number;
  currentFilePath?: string;
}

/**
 * 只声明当前 webhook 处理逻辑真正会读取到的 GitLab Merge Request 字段。
 *
 * 这里没有完整覆盖 GitLab webhook schema，而是用一个最小子集避免
 * 控制器代码里充满 `any`。
 */
interface GitLabMergeRequestWebhookPayload {
  object_kind?: string;
  project?: {
    path_with_namespace?: string;
  };
  object_attributes?: {
    action?: string;
    iid?: number | string;
    oldrev?: string | null;
    last_commit?: {
      id?: string;
      sha?: string;
      commit?: string;
    };
  };
  changes?: {
    last_commit?: unknown;
  };
}

/**
 * 向 Fastify 注册 review 服务对外暴露的所有 HTTP 路由。
 *
 * 这里会挂载健康检查、GitLab Merge Request webhook，以及 CI
 * 主动调用的 review 接口，并把请求分发到对应的调度或执行逻辑。
 */
export function registerReviewController(
  fastify: FastifyInstance,
  options: RegisterReviewControllerOptions
): void {
  /**
   * Dashboard 首页。
   *
   * 这里直接返回内嵌 HTML，而不是单独起一个前端工程，
   * 这样部署时只需要启动一个 Fastify 服务即可。
   */
  fastify.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderDashboardPage();
  });

  /**
   * Dashboard 样式入口。
   */
  fastify.get('/assets/dashboard.css', async (_request, reply) => {
    reply.type('text/css; charset=utf-8');
    return dashboardStyles();
  });

  /**
   * Dashboard 脚本入口。
   */
  fastify.get('/assets/dashboard.js', async (_request, reply) => {
    reply.type('application/javascript; charset=utf-8');
    return dashboardScript();
  });

  /**
   * 提供最小健康检查接口，供容器探活或上游负载均衡判断服务状态。
   */
  fastify.get('/healthz', async () => {
    return { status: 'ok' }
  });

  /**
   * 接收 GitLab Merge Request webhook，并在请求通过校验后异步调度 review。
   *
   * 这个入口只负责“验证并投递任务”，不会同步等待整个 review 跑完。
   * 这样 webhook 可以快速返回，避免被 GitLab 判定为超时。
   */
  fastify.post('/webhook', async (request, reply) => {
    // 当前 webhook 只实现了 GitLab 版本；GitHub 模式请走 /ci/review。
    if (config.SCM_TYPE !== 'gitlab') {
      return reply.status(501).send({ error: 'Webhook endpoint is only implemented for gitlab SCM' });
    }

    // GitLab 模式至少需要有 API token，否则后续无法读取 MR / diff。
    if (!config.GITLAB_TOKEN) {
      return reply.status(503).send({ error: 'GITLAB_TOKEN is not configured' });
    }

    // 如果配置了 webhook secret，这里会做最小校验。
    if (!verifyGitLabWebhook(request)) {
      logger.warn('Invalid GitLab webhook token detected');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as GitLabMergeRequestWebhookPayload;
    const eventName = request.headers['x-gitlab-event'];

    // 非 MR Hook 或非 merge_request 事件直接忽略，避免无关 webhook 误触发。
    if (eventName !== 'Merge Request Hook' || body.object_kind !== 'merge_request') {
      return reply.send({ message: 'Ignored event' });
    }

    // 仅在 open / reopen / update 且真正发生代码变更时触发。
    if (!isMergeRequestUpdateWithCodeChange(body)) {
      return reply.send({ message: 'Ignored merge request action' });
    }

    const projectPath = body.project?.path_with_namespace;
    const mrNumber = Number(body.object_attributes?.iid);
    const headSha =
      body.object_attributes?.last_commit?.id ||
      body.object_attributes?.last_commit?.sha ||
      body.object_attributes?.last_commit?.commit;

    // owner / repo / MR 编号 / head sha 是后续调度最基本的四元组。
    if (!projectPath || !mrNumber || !headSha) {
      logger.warn('GitLab merge request webhook payload is missing required fields', {
        hasProjectPath: Boolean(projectPath),
        mrNumber,
        hasHeadSha: Boolean(headSha),
      });
      return reply.status(400).send({ error: 'Invalid merge request payload' });
    }

    const { owner, repo } = splitProjectPath(projectPath);

    logger.info(`GitLab webhook verified for ${owner}/${repo} MR !${mrNumber}`);
    // 这里调用的是 coordinator 的“异步排队”能力，不阻塞当前 HTTP 响应。
    options.reviewCoordinator.schedule({
      owner,
      repo,
      prNumber: mrNumber,
      headSha,
    });

    return reply.status(202).send({ message: 'Review scheduled' });
  });

  /**
   * 接收 CI 主动触发的 review 请求，支持普通 JSON 响应和 NDJSON 流式进度输出。
   *
   * 这是当前项目最通用的接入入口：
   * - CI/CD 可以直接调用
   * - Dashboard 也复用这个接口
   * - 既支持一次性 JSON，也支持实时 NDJSON
   */
  fastify.post('/ci/review', async (request, reply) => {
    // 两种 SCM 模式分别检查各自的 token，避免后续执行到 provider 才报错。
    if (config.SCM_TYPE === 'gitlab' && !config.GITLAB_TOKEN) {
      return reply.status(503).send({ error: 'GITLAB_TOKEN is not configured' });
    }

    if (config.SCM_TYPE === 'github' && !config.GITHUB_TOKEN) {
      return reply.status(503).send({ error: 'GITHUB_TOKEN is not configured' });
    }

    if (!config.CI_REVIEW_TOKEN) {
      logger.warn('CI review endpoint was called without CI_REVIEW_TOKEN configured');
      return reply.status(503).send({ error: 'CI review token is not configured' });
    }

    const requestToken = extractCiReviewToken(request);
    if (!requestToken || requestToken !== config.CI_REVIEW_TOKEN) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as {
      kind?: 'commit' | 'merge_request';
      author?: string;
      baseSha?: string;
      branch?: string;
      description?: string;
      headSha?: string;
      htmlUrl?: string;
      mergeRequestIid?: number | string;
      projectPath?: string;
      title?: string;
    };

    if (!body.projectPath) {
      return reply.status(400).send({ error: 'projectPath is required' });
    }

    // projectPath 会统一被拆成 provider 需要的 owner / repo 形式。
    const { owner, repo } = splitProjectPath(body.projectPath);
    const requestId = request.id;
    // 兼容两种调用方式：
    // - 显式传 kind=merge_request
    // - 只传 mergeRequestIid，也推断为 merge_request
    const requestedKind =
      body.kind === 'merge_request' || body.mergeRequestIid !== undefined ? 'merge_request' : 'commit';

    let target: ReviewTarget;
    if (requestedKind === 'merge_request') {
      const mergeRequestIid = Number(body.mergeRequestIid);
      if (!Number.isInteger(mergeRequestIid) || mergeRequestIid <= 0) {
        return reply.status(400).send({ error: 'mergeRequestIid is required for merge_request review' });
      }

      target = {
        kind: 'merge_request',
        owner,
        repo,
        number: mergeRequestIid,
      };
    } else {
      // commit 模式下 branch / headSha 是最小必填项，其余元数据只是增强展示。
      if (!body.branch || !body.headSha) {
        return reply.status(400).send({ error: 'branch and headSha are required for commit review' });
      }

      target = {
        kind: 'commit',
        owner,
        repo,
        branch: body.branch,
        baseSha: body.baseSha || '',
        headSha: body.headSha,
        author: body.author,
        title: body.title,
        description: body.description,
        htmlUrl: body.htmlUrl,
      };
    }

    const streamProgress = shouldStreamCiReviewProgress(request);
    logger.info(`Accepted CI review request ${requestId} for ${owner}/${repo}`, {
      streamProgress,
      targetKind: target.kind,
    });

    // 流式模式下，控制器会把 pipeline 的阶段事件转成 NDJSON 持续写给调用方。
    if (streamProgress) {
      const stream = new PassThrough();
      const streamProgressState: StreamProgressState = {
        completedFiles: 0,
        totalFiles: 0,
      };
      // 这里单独创建一个带 onProgress 回调的 pipeline，
      // 使控制器能把内部阶段实时映射成前端可读消息。
      const pipeline = new ReviewPipeline(options.createScmProvider(), {
        onProgress: async (event: ReviewProgressEvent) => {
          writeNdjsonLine(stream, {
            type: 'progress',
            requestId,
            ...decorateProgressEventForStream(event, streamProgressState),
          });
        },
      });
      const heartbeat = setInterval(() => {
        writeNdjsonLine(stream, buildHeartbeatEvent(requestId, streamProgressState));
      }, 10_000);

      // 对反向代理和浏览器显式声明这是一个不该缓冲的 NDJSON 流。
      reply
        .code(200)
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-accel-buffering', 'no')
        .header('x-review-request-id', requestId);

      reply.send(stream);
      writeNdjsonLine(stream, buildAcceptedEvent(requestId, owner, repo, target.kind));

      try {
        // runExclusive 用于保证同一 review 目标不会被并发重复执行。
        const result = await options.reviewCoordinator.runExclusive(
          buildCiReviewExecutionKey(target),
          () => pipeline.run(target)
        );
        const responsePayload = buildReviewResponsePayload(result, requestId);
        const statusCode = resolveReviewHttpStatus(result);

        writeNdjsonLine(stream, buildResultEvent(statusCode, responsePayload));
      } catch (error: unknown) {
        // 流式模式下错误也要通过统一事件返回，避免调用方只能看到连接中断。
        writeNdjsonLine(stream, buildErrorEvent(requestId, error));
      } finally {
        clearInterval(heartbeat);
        stream.end();
      }

      return reply;
    }

    // 同步模式下不返回阶段事件，只在 review 完成后一次性返回最终结果。
    const pipeline = new ReviewPipeline(options.createScmProvider());
    const result = await options.reviewCoordinator.runExclusive(
      buildCiReviewExecutionKey(target),
      () => pipeline.run(target)
    );
    const responsePayload = buildReviewResponsePayload(result, requestId);
    const statusCode = resolveReviewHttpStatus(result);

    if (statusCode !== 200) {
      return reply.status(statusCode).send({
        ...responsePayload,
        message: statusCode === 409 ? 'AI review rejected deployment' : 'AI review failed',
      });
    }

    return reply.send({
      ...responsePayload,
      message: 'AI review passed',
    });
  });
}

/**
 * 把 `group/project` 形式的 GitLab 路径拆成 owner 和 repo。
 *
 * 注意：这里并不强绑定 GitLab，GitHub 的 `owner/repo` 也同样适用。
 * 对于更深层级的 group/project/subproject，owner 会保留斜杠路径。
 */
function splitProjectPath(projectPath: string): { owner: string; repo: string } {
  const segments = projectPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    throw new Error(`Invalid GitLab project path: ${projectPath}`);
  }

  const repo = segments.pop()!;
  return {
    owner: segments.join('/'),
    repo,
  };
}

/**
 * 校验 GitLab webhook 请求头里的 token 是否与服务端配置一致。
 *
 * 如果没有配置 `GITLAB_WEBHOOK_SECRET`，则视为不启用 secret 校验，
 * 直接放行到后续逻辑。
 */
function verifyGitLabWebhook(request: FastifyRequest): boolean {
  if (!config.GITLAB_WEBHOOK_SECRET) {
    return true;
  }

  const token = request.headers['x-gitlab-token'];
  return typeof token === 'string' && token === config.GITLAB_WEBHOOK_SECRET;
}

/**
 * 从自定义请求头或 Bearer Token 中提取 CI review 调用凭证。
 *
 * 支持两种常见调用方式：
 * - `X-Review-Token: <token>`
 * - `Authorization: Bearer <token>`
 */
function extractCiReviewToken(request: FastifyRequest): string | null {
  const directToken = request.headers['x-review-token'];
  if (typeof directToken === 'string' && directToken.trim()) {
    return directToken.trim();
  }

  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  return null;
}

/**
 * 判断当前 CI review 请求是否要求以流式方式返回执行进度。
 *
 * 兼容三种触发方式：
 * - query: `?stream=1`
 * - header: `X-Review-Stream: 1`
 * - header: `Accept: application/x-ndjson`
 */
function shouldStreamCiReviewProgress(request: FastifyRequest): boolean {
  const query = request.query as { stream?: string | boolean } | undefined;
  if (isTruthyFlag(query?.stream)) {
    return true;
  }

  const streamHeader = request.headers['x-review-stream'];
  if (typeof streamHeader === 'string' && isTruthyFlag(streamHeader)) {
    return true;
  }

  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

/**
 * 把布尔型或字符串型开关值统一转换为布尔判断结果。
 *
 * 这样 query/header 里的 `1/true/yes/on/ndjson` 都能被识别成“启用”。
 */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on', 'ndjson'].includes(value.trim().toLowerCase());
  }

  return false;
}

/**
 * 从完整评论列表里提炼一组短摘要，供接口响应快速预览 review 发现。
 *
 * 控制器对外只返回前几条 findings 摘要，避免一次性把完整评论正文
 * 全部塞进首页面板或流式结果里。
 */
function buildFindingPreview(comments: Array<{ path: string; line: number; body: string }>): string[] {
  return comments.slice(0, 8).map((comment) => {
    const firstLine = comment.body.split('\n')[0]?.trim() || 'AI review finding';
    return `${comment.path}:${comment.line} ${firstLine}`;
  });
}

/**
 * 把 review 运行结果整理成对外接口统一返回的数据结构。
 *
 * 这里的结构既用于普通 JSON 响应，也用于流式 result 事件，
 * 所以字段尽量保持扁平、稳定。
 */
function buildReviewResponsePayload(result: ReviewRunResult, requestId: string): {
  review: string;
  requestId: string;
  conclusion: ReviewRunResult['conclusion'];
  commentCount: number;
  syncedCommentCount: number;
  deletedCommentCount: number;
  outdatedCommentCount: number;
  commentSyncFailureCount: number;
  reviewedFileCount: number;
  errorCount: number;
  findings: string[];
  tokenUsagePrompt: number;
  tokenUsageCompletion: number;
  tokenUsageTotal: number;
  comments: Array<{
    path: string;
    line: number;
    body: string;
    side: 'LEFT' | 'RIGHT';
    agentId?: string;
    agentLabel?: string;
  }>;
} {
  return {
    review: result.metadata.displayId,
    requestId,
    conclusion: result.conclusion,
    commentCount: result.comments.length,
    syncedCommentCount: result.commentSync.postedCount,
    deletedCommentCount: result.commentSync.deletedCount,
    outdatedCommentCount: result.commentSync.outdatedCount,
    commentSyncFailureCount: result.commentSync.failedCount,
    reviewedFileCount: result.reviewedFileCount,
    errorCount: result.errorCount,
    findings: buildFindingPreview(result.comments),
    tokenUsagePrompt: result.tokenUsage.promptTokens,
    tokenUsageCompletion: result.tokenUsage.completionTokens,
    tokenUsageTotal: result.tokenUsage.totalTokens,
    comments: result.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      body: comment.body,
      side: comment.side,
      agentId: comment.agentId,
      agentLabel: comment.agentLabel,
    })),
  };
}

/**
 * 向 NDJSON 输出流写入一行 JSON 数据，用于持续推送 review 进度。
 *
 * NDJSON 的核心约束就是“一行一个 JSON 对象”，调用方可以边读边解析。
 */
function writeNdjsonLine(stream: PassThrough, payload: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 把 pipeline 的原始进度事件整理成更适合人类阅读的流式消息格式。
 *
 * pipeline 内部事件更偏工程视角，这里会：
 * - 补充 emoji 和可读消息
 * - 维护完成数量 / 总数
 * - 统一转成前端状态面板可消费的 `progress`
 */
function decorateProgressEventForStream(
  event: ReviewProgressEvent,
  state: StreamProgressState
): ReviewProgressEvent & {
  emoji: string;
  progress?: StreamProgressMetrics;
} {
  const data = event.data ?? {};
  const total = readNumberField(data, 'total')
    ?? readNumberField(data, 'reviewableFileCount')
    ?? readNumberField(data, 'reviewedFileCount')
    ?? state.totalFiles;
  const completed = readNumberField(data, 'completed')
    ?? readNumberField(data, 'reviewedFileCount')
    ?? state.completedFiles;
  const index = readNumberField(data, 'index');
  const pathValue = readStringField(data, 'path');
  const commentCount = readNumberField(data, 'commentCount') ?? 0;
  const syncedCommentCount = readNumberField(data, 'syncedCommentCount') ?? 0;
  const deletedCommentCount = readNumberField(data, 'deletedCommentCount') ?? 0;
  const outdatedCommentCount = readNumberField(data, 'outdatedCommentCount') ?? 0;
  const commentSyncFailureCount = readNumberField(data, 'commentSyncFailureCount') ?? 0;
  const signalCount = readNumberField(data, 'signalCount') ?? 0;
  const findingCount = readNumberField(data, 'findingCount') ?? 0;
  const riskScore = readNumberField(data, 'riskScore');
  const fileConcurrency = readNumberField(data, 'fileConcurrency');
  const llmConcurrency = readNumberField(data, 'llmConcurrency');
  const reviewerAgentCount = readNumberField(data, 'reviewerAgentCount');
  const scale = readStringField(data, 'scale');
  const displayId = readStringField(data, 'displayId');
  const targetLabel = readStringField(data, 'targetLabel');
  const conclusion = readStringField(data, 'conclusion');
  const error = readStringField(data, 'error');
  const agentId = readStringField(data, 'agentId');
  const agentLabel = readStringField(data, 'agentLabel');
  const segmentIndex = readNumberField(data, 'segmentIndex');
  const totalSegments = readNumberField(data, 'totalSegments');
  const agentCommentCount = readNumberField(data, 'agentCommentCount') ?? 0;
  const shortPath = pathValue ? shortenPathForDisplay(pathValue) : undefined;

  // 把每次事件里零散出现的统计字段回填到 state，
  // 让 heartbeat 和后续事件即使缺字段也能保持展示稳定。
  if (typeof total === 'number' && total >= 0) {
    state.totalFiles = total;
  }
  if (typeof completed === 'number' && completed >= 0) {
    state.completedFiles = completed;
  }
  if (pathValue) {
    state.currentFilePath = pathValue;
  }

  switch (event.stage) {
    case 'started':
      return {
        ...event,
        message: `🤖 开始 AI Review：${targetLabel || '当前请求'}`,
        emoji: '🤖',
      };
    case 'metadata_loaded':
      return {
        ...event,
        message: `🧾 已读取评审元数据：${displayId || '当前评审对象'}`,
        emoji: '🧾',
      };
    case 'diff_fetched':
      return {
        ...event,
        message: `📥 已拉取原始 Diff，共 ${readNumberField(data, 'rawFileCount') ?? 0} 个变更文件`,
        emoji: '📥',
      };
    case 'diff_filtered':
      return {
        ...event,
        message: `🧹 Diff 过滤完成，可评审文件 ${readNumberField(data, 'reviewableFileCount') ?? 0} 个`,
        emoji: '🧹',
        progress: buildStreamProgressMetrics(0, total),
      };
    case 'scale_detected':
      return {
        ...event,
        message: `📏 评审规模 ${scale || 'UNKNOWN'}，风险分 ${riskScore ?? 0}`,
        emoji: '📏',
      };
    case 'checkout_prepared':
      return {
        ...event,
        message: '📦 仓库检出完成，开始准备静态分析与上下文',
        emoji: '📦',
      };
    case 'static_analysis_completed':
      return {
        ...event,
        message: `🧪 静态分析完成，命中 ${signalCount} 个信号 / ${findingCount} 个发现`,
        emoji: '🧪',
      };
    case 'review_started':
      state.completedFiles = 0;
      return {
        ...event,
        message: `🔍 开始评审，共 ${total ?? 0} 个文件，review agent ${reviewerAgentCount ?? 1} 个，文件并发 ${fileConcurrency ?? 1} / LLM 并发 ${llmConcurrency ?? fileConcurrency ?? 1}`,
        emoji: '🔍',
        progress: buildStreamProgressMetrics(0, total),
      };
    case 'file_review_started':
      return {
        ...event,
        message: `🔍 正在评审 ${index ?? completed + 1}/${total ?? 0}：${shortPath || pathValue || '当前文件'}`,
        emoji: '🔍',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'agent_review_started':
      return {
        ...event,
        message: `🧠 ${agentLabel || agentId || 'Agent'} 正在审查 ${shortPath || pathValue || '当前文件'}`
          + (segmentIndex && totalSegments && totalSegments > 1 ? `（段 ${segmentIndex}/${totalSegments}）` : ''),
        emoji: '🧠',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'agent_review_completed':
      return {
        ...event,
        message: `🧠 ${agentLabel || agentId || 'Agent'} 完成 ${shortPath || pathValue || '当前文件'}`
          + (segmentIndex && totalSegments && totalSegments > 1 ? `（段 ${segmentIndex}/${totalSegments}）` : '')
          + `，产出 ${agentCommentCount} 条评论`,
        emoji: '🧠',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'agent_review_failed':
      return {
        ...event,
        message: `⚠️ ${agentLabel || agentId || 'Agent'} 审查 ${shortPath || pathValue || '当前文件'} 失败，${error || '将继续其他 agent'}`,
        emoji: '⚠️',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'file_review_completed':
      return {
        ...event,
        message: commentCount > 0
          ? `✅ ${completed}/${total ?? 0}：${shortPath || pathValue || '当前文件'}，发现 ${commentCount} 条问题`
          : `✅ ${completed}/${total ?? 0}：${shortPath || pathValue || '当前文件'}，未发现阻断问题`,
        emoji: '✅',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'file_review_failed':
      return {
        ...event,
        message: `⚠️ ${completed}/${total ?? 0}：${shortPath || pathValue || '当前文件'} 评审失败，${error || '将继续处理剩余文件'}`,
        emoji: '⚠️',
        progress: buildStreamProgressMetrics(completed, total),
      };
    case 'posting_comments':
      return {
        ...event,
        message: `💬 正在同步评论：计划发布 ${commentCount} 条评论`,
        emoji: '💬',
        progress: buildStreamProgressMetrics(state.completedFiles || total || 0, total),
      };
    case 'comments_posted':
      return {
        ...event,
        message: commentSyncFailureCount > 0
          ? `⚠️ 评论同步完成：发布 ${syncedCommentCount} 条，清理 ${deletedCommentCount} 条，保留过期标记 ${outdatedCommentCount} 条，失败 ${commentSyncFailureCount} 条`
          : `💬 评论同步完成：发布 ${syncedCommentCount} 条，清理 ${deletedCommentCount} 条，保留过期标记 ${outdatedCommentCount} 条`,
        emoji: '💬',
        progress: buildStreamProgressMetrics(state.totalFiles || total || 0, state.totalFiles || total),
      };
    case 'completed':
      return {
        ...event,
        message: buildCompletionProgressMessage(
          conclusion,
          total ?? completed,
          syncedCommentCount || commentCount,
          readNumberField(data, 'errorCount') ?? 0,
          commentSyncFailureCount
        ),
        emoji: conclusion === 'failure' || commentSyncFailureCount > 0 ? '❌' : '✅',
        progress: buildStreamProgressMetrics(total ?? completed, total ?? completed),
      };
    case 'failed':
      return {
        ...event,
        message: `💥 AI Review 执行失败：${error || event.message}`,
        emoji: '💥',
      };
    default:
      return {
        ...event,
        message: event.message,
        emoji: 'ℹ️',
      };
  }
}

/**
 * 生成流式 accepted 事件，向调用方确认请求已被接收。
 *
 * 这个事件通常是前端最先收到的一条消息，用来尽快把界面切到“已开始执行”状态。
 */
function buildAcceptedEvent(
  requestId: string,
  owner: string,
  repo: string,
  targetKind: ReviewTarget['kind']
): Record<string, unknown> {
  return {
    type: 'accepted',
    requestId,
    timestamp: new Date().toISOString(),
    message: `🤖 已接收 AI Review 请求，目标 ${owner}/${repo}（${targetKind}）`,
    emoji: '🤖',
    data: {
      owner,
      repo,
      targetKind,
    },
  };
}

/**
 * 基于最新进度快照生成心跳事件，避免长耗时阶段看起来像卡住。
 *
 * 当 checkout、LLM 调用等阶段耗时较长时，heartbeat 可以维持前端活跃感，
 * 同时带上当前文件和完成比例。
 */
function buildHeartbeatEvent(
  requestId: string,
  state: StreamProgressState
): Record<string, unknown> {
  const progress = buildStreamProgressMetrics(state.completedFiles, state.totalFiles);
  const currentFile = state.currentFilePath ? shortenPathForDisplay(state.currentFilePath) : null;

  let message = '⏳ AI Review 进行中';
  if (progress && typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0) {
    message += `，已完成 ${progress.current}/${progress.total} 个文件`;
  }
  if (currentFile && (progress?.current ?? 0) < (progress?.total ?? Number.MAX_SAFE_INTEGER)) {
    message += `，当前 ${currentFile}`;
  }

  return {
    type: 'heartbeat',
    requestId,
    timestamp: new Date().toISOString(),
    message,
    emoji: '⏳',
    progress,
  };
}

/**
 * 生成流式 result 事件，给出最终结论与简短人类可读摘要。
 *
 * result 是流式链路里的“终局事件”：
 * - `statusCode` 表示最终 HTTP 语义
 * - 其余字段和普通 JSON 响应基本保持一致
 */
function buildResultEvent(
  statusCode: number,
  payload: ReturnType<typeof buildReviewResponsePayload>
): Record<string, unknown> {
  const progress = buildStreamProgressMetrics(payload.reviewedFileCount, payload.reviewedFileCount);
  const message = statusCode === 500
    ? `💥 AI Review 执行失败：共 ${payload.reviewedFileCount} 个文件，处理失败 ${payload.errorCount} 项，评论同步失败 ${payload.commentSyncFailureCount} 条`
    : statusCode === 409
      ? `❌ AI Review 未通过：共 ${payload.reviewedFileCount} 个文件，同步 ${payload.syncedCommentCount} 条评论`
      : payload.syncedCommentCount > 0
        ? `✅ AI Review 已完成：共 ${payload.reviewedFileCount} 个文件，同步 ${payload.syncedCommentCount} 条评论`
        : `✅ AI Review 已通过：共 ${payload.reviewedFileCount} 个文件，未发现阻断问题`;

  return {
    type: 'result',
    statusCode,
    ...payload,
    message,
    emoji: statusCode === 500 ? '💥' : statusCode === 409 ? '❌' : '✅',
    progress,
  };
}

/**
 * 生成流式 error 事件，向调用方明确指出执行失败原因。
 *
 * 与直接断开连接相比，显式发 error 事件更利于前端稳定处理失败态。
 */
function buildErrorEvent(requestId: string, error: unknown): Record<string, unknown> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    type: 'error',
    requestId,
    statusCode: 500,
    error: 'Internal Server Error',
    message: `💥 AI Review 执行失败：${errorMessage}`,
    emoji: '💥',
  };
}

/**
 * 读取数据对象中的数字字段，并在可解析时返回数值。
 *
 * pipeline 的 data 字段允许 string/number 混用，这里统一做容错解析。
 */
function readNumberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/**
 * 读取数据对象中的字符串字段，并在非空时返回。
 *
 * 主要用于从 progress event 的 data 里安全提取 path / scale / error 等字段。
 */
function readStringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 根据当前完成数量和总量构造统一的进度指标。
 *
 * 如果缺少 total 或 total <= 0，则返回 undefined，前端会保持当前展示。
 */
function buildStreamProgressMetrics(current?: number, total?: number): StreamProgressMetrics | undefined {
  if (typeof current !== 'number' || typeof total !== 'number' || total <= 0) {
    return undefined;
  }

  return {
    current,
    total,
    percent: Math.max(0, Math.min(100, Math.round((current / total) * 100))),
  };
}

/**
 * 生成 review 完成阶段的简短展示语句。
 *
 * 这里优先按“同步失败 / 文件处理失败 / review 未通过 / 正常完成”的顺序
 * 判断，确保给调用方最关键的失败信号。
 */
function buildCompletionProgressMessage(
  conclusion: string | undefined,
  reviewedFileCount: number,
  commentCount: number,
  errorCount: number,
  commentSyncFailureCount = 0
): string {
  if (commentSyncFailureCount > 0) {
    return `💥 AI Review 完成，但评论同步失败 ${commentSyncFailureCount} 条，请查看日志`;
  }

  if (errorCount > 0) {
    return `⚠️ AI Review 完成，但有 ${errorCount} 个文件处理失败`;
  }

  if (conclusion === 'failure') {
    return `❌ AI Review 完成：共 ${reviewedFileCount} 个文件，发现 ${commentCount} 条问题`;
  }

  if (commentCount > 0) {
    return `✅ AI Review 完成：共 ${reviewedFileCount} 个文件，发布 ${commentCount} 条评论`;
  }

  return `✅ AI Review 完成：共 ${reviewedFileCount} 个文件，未发现阻断问题`;
}

/**
 * 为 CI 主动调用构造稳定的串行化 key，避免同一目标并发执行。
 *
 * merge_request 和 commit 分别使用不同命名空间，避免 key 冲突。
 */
function buildCiReviewExecutionKey(target: ReviewTarget): string {
  if (target.kind === 'merge_request') {
    return `ci:mr:${target.owner}/${target.repo}#${target.number}`;
  }

  return `ci:commit:${target.owner}/${target.repo}@${target.headSha}`;
}

/**
 * 根据 review 结果判断当前 HTTP 响应应返回成功、拒绝还是执行失败。
 *
 * - 500: review 过程本身出错，或评论同步失败
 * - 409: review 成功执行，但给出了阻断性评论
 * - 200: review 成功执行且未阻断
 */
function resolveReviewHttpStatus(result: ReviewRunResult): 200 | 409 | 500 {
  if (result.errorCount > 0 || result.commentSync.failedCount > 0) {
    return 500;
  }

  return result.conclusion === 'failure' ? 409 : 200;
}

/**
 * 缩短长路径，优先保留末尾文件名和上一级目录，便于日志阅读。
 *
 * 例如 `src/services/user/user-service.ts` 会展示成 `user/user-service.ts`。
 */
function shortenPathForDisplay(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/').filter(Boolean);
  if (parts.length <= 2) {
    return normalizedPath;
  }

  return `${parts[parts.length - 2]}/${path.posix.basename(normalizedPath)}`;
}

/**
 * 判断当前 Merge Request webhook 是否代表一次需要重新 review 的代码变更。
 *
 * 规则是：
 * - `open` / `reopen` 一律触发
 * - `update` 只有在 oldrev 或 last_commit 变化时才触发
 *
 * 这样可以避免纯元数据更新把 review 重复跑一遍。
 */
function isMergeRequestUpdateWithCodeChange(body: GitLabMergeRequestWebhookPayload): boolean {
  const action = body.object_attributes?.action;
  if (typeof action !== 'string' || !['open', 'reopen', 'update'].includes(action)) {
    return false;
  }

  if (action !== 'update') {
    return true;
  }

  return Boolean(body.object_attributes?.oldrev || body.changes?.last_commit);
}
