/**
 * 定义 review 服务的核心共享类型。
 *
 * 这个文件集中维护 review 目标、diff、评论、状态检查、RAG 上下文、
 * 进度事件以及 SCM provider 抽象接口，供各层模块复用。
 */

/**
 * 标识当前 review 面向的是 Merge Request 还是单次 commit。
 */
export type ReviewTargetKind = 'merge_request' | 'commit';

/**
 * 描述一次 Git diff 对比使用的三段提交引用。
 */
export interface ReviewDiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

/**
 * 描述一次 review 对象的元数据，包括来源仓库、分支和展示信息。
 */
export interface PullRequestMetadata {
  id: string;
  number?: number;
  title: string;
  description: string;
  htmlUrl: string;
  owner: string;
  repo: string;
  sourceBranch: string;
  headSha: string;
  targetBranch: string;
  author: string;
  kind: ReviewTargetKind;
  displayId: string;
  baseSha?: string;
  diffRefs?: ReviewDiffRefs;
}

/**
 * 表示单个 diff hunk 的原始文本及新旧行号范围。
 */
export interface DiffChunk {
  content: string; // 原始 diff 片段
  newRange: { start: number; lines: number };
  oldRange: { start: number; lines: number };
}

/**
 * 表示单个文件级 diff 及其变更类型。
 */
export interface FileDiff {
  path: string;
  chunks: DiffChunk[];
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

/**
 * 标识 review 静态信号的来源类型。
 */
export type ReviewSignalSource = 'tsquery' | 'dependency-cruiser' | 'eslint' | 'diff-impact' | 'contract';

/**
 * 表示一个高置信度静态分析信号摘要。
 */
export interface ReviewSignal {
  source: ReviewSignalSource;
  summary: string;
  line?: number;
}

/**
 * 表示一段可直接注入提示词的代码片段或语义摘要。
 */
export interface CodeContextSnippet {
  label: string;
  content: string;
  file: string;
}

/**
 * 表示从旧版本代码中提取出的、与删除型改动相关的上下文。
 */
export interface DeletedCodeContext {
  name?: string;
  reason: string;
  content: string;
  file: string;
}

/**
 * RAG 提取的上下文
 */
export interface CodeContext {
  functions: Array<{ name: string; content: string; file: string }>;
  types: Array<{ name: string; content: string; file: string }>;
  semanticSlices: CodeContextSnippet[];
  deletedScopes: DeletedCodeContext[];
  signals: ReviewSignal[];
}

/**
 * 表示一条最终可回写到 SCM 的 review 评论。
 */
export interface ReviewComment {
  path: string;
  oldPath?: string;
  line: number;
  body: string;
  side: 'LEFT' | 'RIGHT';
  agentId?: string;
  agentLabel?: string;
}

/**
 * 标识评论同步属于哪条输出通道，便于不同分析链路独立维护评论。
 */
export type ReviewCommentChannel = 'ai-review';

/**
 * 描述一次评论同步的执行选项。
 */
export interface ReviewCommentSyncOptions {
  channel?: ReviewCommentChannel;
}

/**
 * 描述一次评论同步到 SCM 的实际执行结果。
 */
export interface ReviewCommentSyncResult {
  attemptedCount: number;
  postedCount: number;
  deletedCount: number;
  outdatedCount: number;
  failedCount: number;
}

/**
 * 汇总一次 review 运行内所有 LLM 调用的 token 使用量。
 */
export interface TokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 表示静态分析器直接产出的结构化发现。
 */
export interface StaticReviewFinding extends ReviewComment {
  source: Exclude<ReviewSignalSource, 'tsquery'>;
  ruleId: string;
  severity: 'error' | 'warn';
}

/**
 * 标识本次 review 的规模级别。
 */
export type ReviewScale = 'SMALL' | 'MEDIUM' | 'LARGE';

/**
 * 标识 review 检查运行在 SCM 侧的状态值。
 */
export type ReviewCheckStatus = 'queued' | 'in_progress' | 'completed';

/**
 * 标识 review 检查完成后的结论。
 */
export type ReviewCheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required';

/**
 * 描述 SCM 返回的状态检查标识信息。
 */
export interface ReviewCheckRun {
  id: number;
  url?: string;
  name?: string;
}

/**
 * 创建状态检查时使用的请求载荷。
 */
export interface ReviewCheckRunPayload {
  name: string;
  headSha: string;
  detailsUrl?: string;
  externalId?: string;
  status: ReviewCheckStatus;
  conclusion?: ReviewCheckConclusion;
  startedAt?: string;
  completedAt?: string;
  output: {
    title: string;
    summary: string;
    text?: string;
  };
}

/**
 * 更新状态检查时使用的请求载荷。
 */
export interface ReviewCheckRunUpdatePayload {
  detailsUrl?: string;
  status: ReviewCheckStatus;
  conclusion?: ReviewCheckConclusion;
  startedAt?: string;
  completedAt?: string;
  output: {
    title: string;
    summary: string;
    text?: string;
  };
}

/**
 * 表示 review 请求实际指向的对象，可为 Merge Request 或 commit。
 */
export type ReviewTarget =
  | {
      kind: 'merge_request';
      owner: string;
      repo: string;
      number: number;
    }
  | {
      kind: 'commit';
      owner: string;
      repo: string;
      branch: string;
      baseSha: string;
      headSha: string;
      author?: string;
      title?: string;
      description?: string;
      htmlUrl?: string;
    };

/**
 * 表示一次完整 review 执行后的输出结果。
 */
export interface ReviewRunResult {
  metadata: PullRequestMetadata;
  comments: ReviewComment[];
  conclusion: ReviewCheckConclusion;
  reviewedFileCount: number;
  errorCount: number;
  commentSync: ReviewCommentSyncResult;
  tokenUsage: TokenUsageSummary;
}

/**
 * 标识 review 流程中的细分进度阶段。
 */
export type ReviewProgressStage =
  | 'started'
  | 'metadata_loaded'
  | 'diff_fetched'
  | 'diff_filtered'
  | 'scale_detected'
  | 'checkout_prepared'
  | 'static_analysis_completed'
  | 'review_started'
  | 'file_review_started'
  | 'agent_review_started'
  | 'agent_review_completed'
  | 'agent_review_failed'
  | 'file_review_completed'
  | 'file_review_failed'
  | 'posting_comments'
  | 'comments_posted'
  | 'completed'
  | 'failed';

/**
 * 表示对外流式推送的一条 review 进度事件。
 */
export interface ReviewProgressEvent {
  stage: ReviewProgressStage;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * SCM Provider 抽象接口
 */
export interface ISCMProvider {
  getReviewMetadata(target: ReviewTarget): Promise<PullRequestMetadata>;
  getDiff(target: ReviewTarget, metadata: PullRequestMetadata): Promise<FileDiff[]>;
  postComments(
    target: ReviewTarget,
    metadata: PullRequestMetadata,
    comments: ReviewComment[],
    options?: ReviewCommentSyncOptions
  ): Promise<ReviewCommentSyncResult>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string>;
  searchCode(owner: string, repo: string, query: string): Promise<string[]>; // 返回匹配的文件路径列表
  createReviewStatus?(metadata: PullRequestMetadata, payload: ReviewCheckRunPayload): Promise<ReviewCheckRun | null>;
  updateReviewStatus?(metadata: PullRequestMetadata, checkRun: ReviewCheckRun, payload: ReviewCheckRunUpdatePayload): Promise<void>;
}
