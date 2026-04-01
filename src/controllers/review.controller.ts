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

interface RegisterReviewControllerOptions {
  createScmProvider: () => ISCMProvider;
  reviewCoordinator: ReviewCoordinator;
}

interface StreamProgressMetrics {
  current?: number;
  total?: number;
  percent?: number;
}

interface StreamProgressState {
  completedFiles: number;
  totalFiles: number;
  currentFilePath?: string;
}

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
  fastify.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderDashboardPage();
  });

  fastify.get('/assets/dashboard.css', async (_request, reply) => {
    reply.type('text/css; charset=utf-8');
    return dashboardStyles();
  });

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
   */
  fastify.post('/webhook', async (request, reply) => {
    if (config.SCM_TYPE !== 'gitlab') {
      return reply.status(501).send({ error: 'Webhook endpoint is only implemented for gitlab SCM' });
    }

    if (!config.GITLAB_TOKEN) {
      return reply.status(503).send({ error: 'GITLAB_TOKEN is not configured' });
    }

    if (!verifyGitLabWebhook(request)) {
      logger.warn('Invalid GitLab webhook token detected');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as GitLabMergeRequestWebhookPayload;
    const eventName = request.headers['x-gitlab-event'];

    if (eventName !== 'Merge Request Hook' || body.object_kind !== 'merge_request') {
      return reply.send({ message: 'Ignored event' });
    }

    if (!isMergeRequestUpdateWithCodeChange(body)) {
      return reply.send({ message: 'Ignored merge request action' });
    }

    const projectPath = body.project?.path_with_namespace;
    const mrNumber = Number(body.object_attributes?.iid);
    const headSha =
      body.object_attributes?.last_commit?.id ||
      body.object_attributes?.last_commit?.sha ||
      body.object_attributes?.last_commit?.commit;

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
   */
  fastify.post('/ci/review', async (request, reply) => {
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

    const { owner, repo } = splitProjectPath(body.projectPath);
    const requestId = request.id;
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

    if (streamProgress) {
      const stream = new PassThrough();
      const streamProgressState: StreamProgressState = {
        completedFiles: 0,
        totalFiles: 0,
      };
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

      reply
        .code(200)
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-accel-buffering', 'no')
        .header('x-review-request-id', requestId);

      reply.send(stream);
      writeNdjsonLine(stream, buildAcceptedEvent(requestId, owner, repo, target.kind));

      try {
        const result = await options.reviewCoordinator.runExclusive(
          buildCiReviewExecutionKey(target),
          () => pipeline.run(target)
        );
        const responsePayload = buildReviewResponsePayload(result, requestId);
        const statusCode = resolveReviewHttpStatus(result);

        writeNdjsonLine(stream, buildResultEvent(statusCode, responsePayload));
      } catch (error: unknown) {
        writeNdjsonLine(stream, buildErrorEvent(requestId, error));
      } finally {
        clearInterval(heartbeat);
        stream.end();
      }

      return reply;
    }

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
 */
function buildFindingPreview(comments: Array<{ path: string; line: number; body: string }>): string[] {
  return comments.slice(0, 8).map((comment) => {
    const firstLine = comment.body.split('\n')[0]?.trim() || 'AI review finding';
    return `${comment.path}:${comment.line} ${firstLine}`;
  });
}

/**
 * 把 review 运行结果整理成对外接口统一返回的数据结构。
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
  };
}

/**
 * 向 NDJSON 输出流写入一行 JSON 数据，用于持续推送 review 进度。
 */
function writeNdjsonLine(stream: PassThrough, payload: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

/**
 * 把 pipeline 的原始进度事件整理成更适合人类阅读的流式消息格式。
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
  const scale = readStringField(data, 'scale');
  const displayId = readStringField(data, 'displayId');
  const targetLabel = readStringField(data, 'targetLabel');
  const conclusion = readStringField(data, 'conclusion');
  const error = readStringField(data, 'error');
  const shortPath = pathValue ? shortenPathForDisplay(pathValue) : undefined;

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
        message: `🔍 开始评审，共 ${total ?? 0} 个文件，文件并发 ${fileConcurrency ?? 1} / LLM 并发 ${llmConcurrency ?? fileConcurrency ?? 1}`,
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
 */
function readStringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 根据当前完成数量和总量构造统一的进度指标。
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
 */
function buildCiReviewExecutionKey(target: ReviewTarget): string {
  if (target.kind === 'merge_request') {
    return `ci:mr:${target.owner}/${target.repo}#${target.number}`;
  }

  return `ci:commit:${target.owner}/${target.repo}@${target.headSha}`;
}

/**
 * 根据 review 结果判断当前 HTTP 响应应返回成功、拒绝还是执行失败。
 */
function resolveReviewHttpStatus(result: ReviewRunResult): 200 | 409 | 500 {
  if (result.errorCount > 0 || result.commentSync.failedCount > 0) {
    return 500;
  }

  return result.conclusion === 'failure' ? 409 : 200;
}

/**
 * 缩短长路径，优先保留末尾文件名和上一级目录，便于日志阅读。
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
