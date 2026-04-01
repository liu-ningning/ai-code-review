/**
 * 提供面向 GitLab API 的 SCM 能力实现。
 *
 * 这个文件负责获取 Merge Request 或 commit 元数据、读取 diff 与文件内容、
 * 回写评论，以及同步 review 状态到 GitLab commit status。
 */
import axios, { AxiosInstance } from 'axios';
import {
  FileDiff,
  ISCMProvider,
  PullRequestMetadata,
  ReviewCheckConclusion,
  ReviewCheckRun,
  ReviewCheckRunPayload,
  ReviewCheckRunUpdatePayload,
  ReviewCommentChannel,
  ReviewComment,
  ReviewCommentSyncResult,
  ReviewCommentSyncOptions,
  ReviewDiffRefs,
  ReviewTarget,
} from '../../types/index.js';
import { DiffParser } from './diff-parser.js';
import { ProviderError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/error-utils.js';

interface GitLabProviderOptions {
  token?: string;
  baseUrl: string;
}

interface GitLabDiffEntry {
  deleted_file: boolean;
  diff: string;
  new_file: boolean;
  new_path: string;
  old_path: string;
  renamed_file: boolean;
}

interface GitLabMergeRequestResponse {
  author?: {
    name?: string;
    username?: string;
  };
  description?: string | null;
  diff_refs?: {
    base_sha?: string;
    head_sha?: string;
    start_sha?: string;
  } | null;
  iid: number;
  id: number;
  sha?: string | null;
  source_branch: string;
  target_branch: string;
  title: string;
  web_url: string;
}

interface GitLabMergeRequestVersion {
  base_commit_sha: string;
  head_commit_sha: string;
  id: number;
  start_commit_sha: string;
}

interface GitLabCommitResponse {
  author_name?: string;
  committed_date?: string;
  id: string;
  message?: string;
  parent_ids?: string[];
  short_id?: string;
  title?: string;
  web_url?: string;
}

interface GitLabCompareResponse {
  compare_same_ref?: boolean;
  compare_timeout?: boolean;
  diffs?: GitLabDiffEntry[];
}

interface GitLabSearchResult {
  path?: string;
}

interface GitLabStatusResponse {
  id: number;
  target_url?: string | null;
}

interface GitLabCurrentUserResponse {
  id: number;
  username?: string;
}

interface GitLabDiscussionAuthor {
  id?: number;
  username?: string;
}

interface GitLabDiscussionNote {
  id: number;
  body?: string;
  system?: boolean;
  author?: GitLabDiscussionAuthor;
}

interface GitLabDiscussion {
  id: string;
  notes?: GitLabDiscussionNote[];
}

interface GitLabAiCleanupCandidate {
  discussionId: string;
  deletableNoteIds: number[];
  staleNotes: Array<{ id: number; body: string }>;
}

const AI_COMMENT_MARKER = '<!-- ai-review-server-comment -->';
const AI_OUTDATED_MARKER = '<!-- ai-review-server-outdated -->';
const SEARCH_RESULTS_PER_PAGE = 100;
const MAX_SEARCH_PAGES = 5;
const MAX_SEARCH_RESULTS = 200;

/**
 * 基于 GitLab REST API 实现 review 服务所需的 SCM 操作。
 */
export class GitLabProvider implements ISCMProvider {
  private readonly client: AxiosInstance;
  private readonly webBaseUrl: string;
  // 清理旧评论时需要确认“当前 token 是哪个用户”，这里缓存结果，
  // 避免每次同步评论都重复拉一次 `/user`。
  private currentUserPromise: Promise<GitLabCurrentUserResponse | null> | null = null;

  /**
   * 创建 GitLab provider，并初始化 API 客户端。
   */
  constructor(options: GitLabProviderOptions) {
    if (!options.token) {
      throw new ProviderError('GitLab authentication is not configured');
    }

    this.webBaseUrl = options.baseUrl.replace(/\/$/, '');
    this.client = axios.create({
      baseURL: `${this.webBaseUrl}/api/v4`,
      headers: {
        'PRIVATE-TOKEN': options.token,
      },
      timeout: 30_000,
    });
  }

  /**
   * 根据 review 目标读取对应的 Merge Request 或 commit 元数据。
   */
  async getReviewMetadata(target: ReviewTarget): Promise<PullRequestMetadata> {
    if (target.kind === 'merge_request') {
      return this.getMergeRequestMetadata(target);
    }

    return this.getCommitMetadata(target);
  }

  /**
   * 根据 review 目标拉取对应 diff 列表。
   */
  async getDiff(target: ReviewTarget, metadata: PullRequestMetadata): Promise<FileDiff[]> {
    if (target.kind === 'merge_request') {
      return this.getMergeRequestDiff(target);
    }

    return this.getCommitDiff(target, metadata);
  }

  /**
   * 把生成的 review 评论回写到 GitLab 的 Merge Request 或 commit 上。
   */
  async postComments(
    target: ReviewTarget,
    metadata: PullRequestMetadata,
    comments: ReviewComment[],
    options: ReviewCommentSyncOptions = {}
  ): Promise<ReviewCommentSyncResult> {
    const channel = options.channel ?? 'ai-review';
    const syncResult: ReviewCommentSyncResult = {
      attemptedCount: comments.length,
      postedCount: 0,
      deletedCount: 0,
      outdatedCount: 0,
      failedCount: 0,
    };

    // GitLab discussion 体系下，多轮 review 最容易造成“旧评论残留 + 新评论再发一遍”。
    // 这里先做清理/过期标记，再发本轮评论，尽量让目标页面只保留最新结论。
    if (target.kind === 'merge_request') {
      const cleanupResult = await this.clearExistingMergeRequestAiComments(target, channel);
      syncResult.deletedCount += cleanupResult.deletedCount;
      syncResult.outdatedCount += cleanupResult.outdatedCount;
      syncResult.failedCount += cleanupResult.failedCount;

      const postResult = await this.postMergeRequestComments(target, metadata, comments, channel);
      syncResult.postedCount += postResult.postedCount;
      syncResult.failedCount += postResult.failedCount;
      return syncResult;
    }

    const cleanupResult = await this.clearExistingCommitAiComments(target, channel);
    syncResult.deletedCount += cleanupResult.deletedCount;
    syncResult.outdatedCount += cleanupResult.outdatedCount;
    syncResult.failedCount += cleanupResult.failedCount;

    const postResult = await this.postCommitComments(target, comments, channel);
    syncResult.postedCount += postResult.postedCount;
    syncResult.failedCount += postResult.failedCount;
    return syncResult;
  }

  /**
   * 读取仓库指定 ref 下的文件原始内容。
   */
  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    try {
      const projectId = this.buildProjectId(owner, repo);
      const filePath = encodeURIComponent(path);
      const { data } = await this.client.get<string>(
        `/projects/${projectId}/repository/files/${filePath}/raw`,
        {
          params: { ref },
          responseType: 'text',
        }
      );

      return typeof data === 'string' ? data : String(data ?? '');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (statusCode === 404) {
        logger.debug(`GitLab file content lookup missed: ${path}@${ref}`);
        return '';
      }

      logger.error(`Failed to fetch file content: ${path}@${ref}`, {
        error: errorMessage,
        statusCode,
      });
      return '';
    }
  }

  /**
   * 使用 GitLab 代码搜索接口查找可能相关的文件路径。
   */
  async searchCode(owner: string, repo: string, query: string): Promise<string[]> {
    try {
      const projectId = this.buildProjectId(owner, repo);
      const results = new Set<string>();
      let currentPage = 1;

      // GitLab search 通过响应头返回下一页信息，而不是直接在 body 里给 total count。
      // 这里按 header 驱动翻页，并施加页数/结果上限，控制 provider 延迟。
      for (let pageCount = 0; pageCount < MAX_SEARCH_PAGES && results.size < MAX_SEARCH_RESULTS; pageCount += 1) {
        const response = await this.client.get<GitLabSearchResult[]>(`/projects/${projectId}/search`, {
          params: {
            scope: 'blobs',
            search: query,
            page: currentPage,
            per_page: SEARCH_RESULTS_PER_PAGE,
          },
        });

        for (const item of response.data) {
          const candidatePath = item.path?.trim();
          if (!candidatePath) {
            continue;
          }

          results.add(candidatePath);
          if (results.size >= MAX_SEARCH_RESULTS) {
            break;
          }
        }

        const nextPageHeader = response.headers['x-next-page'];
        const nextPage = typeof nextPageHeader === 'string' && nextPageHeader.trim()
          ? Number.parseInt(nextPageHeader, 10)
          : 0;
        if (!Number.isFinite(nextPage) || nextPage <= currentPage) {
          break;
        }

        currentPage = nextPage;
      }

      return Array.from(results);
    } catch (error: unknown) {
      logger.error(`GitLab search failed for: ${query}`, {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  /**
   * 创建一条 review 状态检查记录，并返回其标识信息。
   */
  async createReviewStatus(
    metadata: PullRequestMetadata,
    payload: ReviewCheckRunPayload
  ): Promise<ReviewCheckRun | null> {
    try {
      const data = await this.setCommitStatus(metadata, payload.name, payload);
      return {
        id: data.id,
        url: data.target_url ?? undefined,
        name: payload.name,
      };
    } catch (error: unknown) {
      logger.warn(`Failed to create GitLab review status for ${metadata.owner}/${metadata.repo}`, {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * 更新一条已存在的 review 状态检查记录。
   */
  async updateReviewStatus(
    metadata: PullRequestMetadata,
    checkRun: ReviewCheckRun,
    payload: ReviewCheckRunUpdatePayload
  ): Promise<void> {
    try {
      await this.setCommitStatus(metadata, checkRun.name || 'AI Review', payload);
    } catch (error: unknown) {
      logger.warn(`Failed to update GitLab review status for ${metadata.owner}/${metadata.repo}`, {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * 读取 Merge Request 元数据，并补齐 diff refs 等 review 所需字段。
   *
   * GitLab MR 有时不会稳定返回完整的 `diff_refs`，因此这里会在必要时额外查询
   * 最新版本信息，保证后续行级评论能拿到完整 base/start/head 三元组。
   */
  private async getMergeRequestMetadata(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<PullRequestMetadata> {
    const projectId = this.buildProjectId(target.owner, target.repo);

    try {
      const { data } = await this.client.get<GitLabMergeRequestResponse>(
        `/projects/${projectId}/merge_requests/${target.number}`
      );
      const diffRefs = data.diff_refs ? this.normalizeDiffRefs(data.diff_refs) : await this.getLatestMergeRequestDiffRefs(target);
      const headSha = data.sha || diffRefs.headSha;

      return {
        id: String(data.id),
        number: data.iid,
        title: data.title,
        description: data.description || '',
        htmlUrl: data.web_url,
        owner: target.owner,
        repo: target.repo,
        sourceBranch: data.source_branch,
        headSha,
        targetBranch: data.target_branch,
        author: data.author?.username || data.author?.name || 'unknown',
        kind: 'merge_request',
        displayId: `!${data.iid}`,
        baseSha: diffRefs.baseSha,
        diffRefs,
      };
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitLab merge request: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * 读取 commit 元数据，并构造 commit review 模式使用的统一描述对象。
   */
  private async getCommitMetadata(
    target: Extract<ReviewTarget, { kind: 'commit' }>
  ): Promise<PullRequestMetadata> {
    const projectId = this.buildProjectId(target.owner, target.repo);

    try {
      const { data } = await this.client.get<GitLabCommitResponse>(
        `/projects/${projectId}/repository/commits/${encodeURIComponent(target.headSha)}`
      );
      const baseSha = this.resolveBaseSha(target.baseSha, data.parent_ids);
      const shortSha = data.short_id || target.headSha.slice(0, 8);

      return {
        id: data.id,
        title: target.title || data.title || `Review commit ${shortSha}`,
        description: target.description || data.message || `Push review for ${target.branch}`,
        htmlUrl: target.htmlUrl || data.web_url || this.buildCommitUrl(target.owner, target.repo, target.headSha),
        owner: target.owner,
        repo: target.repo,
        sourceBranch: target.branch,
        headSha: target.headSha,
        targetBranch: target.branch,
        author: target.author || data.author_name || 'unknown',
        kind: 'commit',
        displayId: `${target.branch}@${shortSha}`,
        baseSha,
        diffRefs: {
          baseSha,
          startSha: baseSha,
          headSha: target.headSha,
        },
      };
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitLab commit: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * 分页拉取 Merge Request diff，并转换成内部 FileDiff 结构。
   *
   * GitLab 的 MR diffs 接口会分页，而且可能返回 rename/add/delete 等多种状态标记，
   * 这里统一规整成 `FileDiff` 供后续主流程消费。
   */
  private async getMergeRequestDiff(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<FileDiff[]> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    const diffs: GitLabDiffEntry[] = [];
    let page = 1;

    try {
      while (true) {
        const response = await this.client.get<GitLabDiffEntry[]>(
          `/projects/${projectId}/merge_requests/${target.number}/diffs`,
          {
            params: {
              page,
              per_page: 100,
              unidiff: true,
            },
          }
        );
        diffs.push(...response.data);

        const nextPage = Number(response.headers['x-next-page'] || 0);
        if (!nextPage) {
          break;
        }

        page = nextPage;
      }

      return diffs.map((file) => this.parseDiffEntry(file));
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitLab merge request diff: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * 基于 compare 接口拉取两个 commit 之间的 diff。
   *
   * compare 超时或同引用比较时都不应视为致命错误；前者打告警，后者直接视为无 diff。
   */
  private async getCommitDiff(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    metadata: PullRequestMetadata
  ): Promise<FileDiff[]> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    const baseSha = metadata.baseSha || target.baseSha;

    if (!baseSha || baseSha === target.headSha) {
      return [];
    }

    try {
      const { data } = await this.client.get<GitLabCompareResponse>(
        `/projects/${projectId}/repository/compare`,
        {
          params: {
            from: baseSha,
            to: target.headSha,
            straight: true,
            unidiff: true,
          },
        }
      );

      if (data.compare_timeout) {
        logger.warn(`GitLab compare timed out for ${target.owner}/${target.repo}`, {
          baseSha,
          headSha: target.headSha,
        });
      }

      if (data.compare_same_ref) {
        return [];
      }

      return (data.diffs || []).map((file) => this.parseDiffEntry(file));
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitLab compare diff: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * 把评论逐条发布到 Merge Request discussion 中。
   *
   * GitLab 的行级评论依赖 position 对象，base/start/head 和左右侧行号必须匹配，
   * 因此 metadata.diffRefs 是 MR 评论发布的关键前置条件。
   */
  private async postMergeRequestComments(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>,
    metadata: PullRequestMetadata,
    comments: ReviewComment[],
    channel: ReviewCommentChannel
  ): Promise<{ postedCount: number; failedCount: number }> {
    if (!metadata.diffRefs) {
      throw new ProviderError('GitLab merge request diff references are missing');
    }

    const projectId = this.buildProjectId(target.owner, target.repo);
    let successCount = 0;
    let failedCount = 0;

    for (const comment of comments) {
      try {
        const position: Record<string, number | string> = {
          position_type: 'text',
          base_sha: metadata.diffRefs.baseSha,
          start_sha: metadata.diffRefs.startSha,
          head_sha: metadata.diffRefs.headSha,
          old_path: comment.oldPath || comment.path,
          new_path: comment.path,
        };

        if (comment.side === 'LEFT') {
          position.old_line = comment.line;
        } else {
          position.new_line = comment.line;
        }

        await this.client.post(
          `/projects/${projectId}/merge_requests/${target.number}/discussions`,
          {
            body: this.decorateAiCommentBody(comment.body, channel),
            position,
          }
        );
        successCount++;
      } catch (error: unknown) {
        failedCount += 1;
        logger.warn(`Failed to post GitLab MR comment for ${target.owner}/${target.repo}!${target.number}`, {
          error: getErrorMessage(error),
          line: comment.line,
          path: comment.path,
        });
      }
    }

    logger.info(`Posted ${successCount}/${comments.length} comments to GitLab MR !${target.number}`);
    return { postedCount: successCount, failedCount };
  }

  /**
   * 把评论逐条发布到 commit 评论接口中。
   */
  private async postCommitComments(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    comments: ReviewComment[],
    channel: ReviewCommentChannel
  ): Promise<{ postedCount: number; failedCount: number }> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    let successCount = 0;
    let failedCount = 0;

    for (const comment of comments) {
      try {
        await this.client.post(
          `/projects/${projectId}/repository/commits/${encodeURIComponent(target.headSha)}/comments`,
          null,
          {
            params: {
              note: this.decorateAiCommentBody(comment.body, channel),
              path: comment.side === 'LEFT' ? comment.oldPath || comment.path : comment.path,
              line: comment.line,
              line_type: comment.side === 'LEFT' ? 'old' : 'new',
            },
          }
        );
        successCount++;
      } catch (error: unknown) {
        failedCount += 1;
        logger.warn(`Failed to post GitLab commit comment for ${target.owner}/${target.repo}@${target.headSha}`, {
          error: getErrorMessage(error),
          line: comment.line,
          path: comment.path,
        });
      }
    }

    logger.info(`Posted ${successCount}/${comments.length} comments to GitLab commit ${target.headSha}`);
    return { postedCount: successCount, failedCount };
  }

  /**
   * 在发布新 MR 评论前，清理当前目标上上一轮 AI 留下的旧评论。
   *
   * 对纯 AI discussion 直接删除；如果 discussion 里已经混入人工回复，则只把 AI note
   * 标成“已过期”，避免破坏人工讨论上下文。
   */
  private async clearExistingMergeRequestAiComments(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>,
    channel: ReviewCommentChannel
  ): Promise<{ deletedCount: number; outdatedCount: number; failedCount: number }> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    const cleanupTargets = await this.listMergeRequestAiCleanupCandidates(projectId, target.number, channel);
    let removedCount = 0;
    let outdatedCount = 0;
    let failedCount = 0;

    for (const candidate of cleanupTargets) {
      for (const noteId of candidate.deletableNoteIds) {
        try {
          await this.client.delete(
            `/projects/${projectId}/merge_requests/${target.number}/discussions/${encodeURIComponent(candidate.discussionId)}/notes/${noteId}`
          );
          removedCount += 1;
        } catch (error: unknown) {
          failedCount += 1;
          logger.warn(`Failed to delete stale GitLab MR AI comment for ${target.owner}/${target.repo}!${target.number}`, {
            error: getErrorMessage(error),
            discussionId: candidate.discussionId,
            noteId,
          });
        }
      }

      for (const staleNote of candidate.staleNotes) {
        try {
          await this.client.put(
            `/projects/${projectId}/merge_requests/${target.number}/discussions/${encodeURIComponent(candidate.discussionId)}/notes/${staleNote.id}`,
            {
              body: this.buildOutdatedAiCommentBody(staleNote.body, channel),
            }
          );
          outdatedCount += 1;
        } catch (error: unknown) {
          failedCount += 1;
          logger.warn(`Failed to mark stale GitLab MR AI comment as outdated for ${target.owner}/${target.repo}!${target.number}`, {
            error: getErrorMessage(error),
            discussionId: candidate.discussionId,
            noteId: staleNote.id,
          });
        }
      }
    }

    if (removedCount > 0 || outdatedCount > 0) {
      logger.info(`Reconciled stale AI comments on GitLab MR !${target.number}`, {
        removedCount,
        outdatedCount,
      });
    }

    return {
      deletedCount: removedCount,
      outdatedCount,
      failedCount,
    };
  }

  /**
   * 在发布新 commit 评论前，清理当前 commit 上上一轮 AI 留下的旧评论。
   */
  private async clearExistingCommitAiComments(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    channel: ReviewCommentChannel
  ): Promise<{ deletedCount: number; outdatedCount: number; failedCount: number }> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    const cleanupTargets = await this.listCommitAiCleanupCandidates(projectId, target.headSha, channel);
    let removedCount = 0;
    let outdatedCount = 0;
    let failedCount = 0;

    for (const candidate of cleanupTargets) {
      for (const noteId of candidate.deletableNoteIds) {
        try {
          await this.client.delete(
            `/projects/${projectId}/repository/commits/${encodeURIComponent(target.headSha)}/discussions/${encodeURIComponent(candidate.discussionId)}/notes/${noteId}`
          );
          removedCount += 1;
        } catch (error: unknown) {
          failedCount += 1;
          logger.warn(`Failed to delete stale GitLab commit AI comment for ${target.owner}/${target.repo}@${target.headSha}`, {
            error: getErrorMessage(error),
            discussionId: candidate.discussionId,
            noteId,
          });
        }
      }

      for (const staleNote of candidate.staleNotes) {
        try {
          await this.client.put(
            `/projects/${projectId}/repository/commits/${encodeURIComponent(target.headSha)}/discussions/${encodeURIComponent(candidate.discussionId)}/notes/${staleNote.id}`,
            {
              body: this.buildOutdatedAiCommentBody(staleNote.body, channel),
            }
          );
          outdatedCount += 1;
        } catch (error: unknown) {
          failedCount += 1;
          logger.warn(`Failed to mark stale GitLab commit AI comment as outdated for ${target.owner}/${target.repo}@${target.headSha}`, {
            error: getErrorMessage(error),
            discussionId: candidate.discussionId,
            noteId: staleNote.id,
          });
        }
      }
    }

    if (removedCount > 0 || outdatedCount > 0) {
      logger.info(`Reconciled stale AI comments on GitLab commit ${target.headSha}`, {
        removedCount,
        outdatedCount,
      });
    }

    return {
      deletedCount: removedCount,
      outdatedCount,
      failedCount,
    };
  }

  /**
   * 列出当前 MR 下可安全清理的旧 AI discussion note。
   */
  private async listMergeRequestAiCleanupCandidates(
    projectId: string,
    mergeRequestIid: number,
    channel: ReviewCommentChannel
  ): Promise<GitLabAiCleanupCandidate[]> {
    const discussions = await this.listAllDiscussions(
      `/projects/${projectId}/merge_requests/${mergeRequestIid}/discussions`
    );
    return this.extractAiCleanupCandidates(discussions, channel);
  }

  /**
   * 列出当前 commit 下可安全清理的旧 AI discussion note。
   */
  private async listCommitAiCleanupCandidates(
    projectId: string,
    commitSha: string,
    channel: ReviewCommentChannel
  ): Promise<GitLabAiCleanupCandidate[]> {
    const discussions = await this.listAllDiscussions(
      `/projects/${projectId}/repository/commits/${encodeURIComponent(commitSha)}/discussions`
    );
    return this.extractAiCleanupCandidates(discussions, channel);
  }

  /**
   * 分页读取 discussion 列表，供评论清理逻辑复用。
   */
  private async listAllDiscussions(endpoint: string): Promise<GitLabDiscussion[]> {
    const discussions: GitLabDiscussion[] = [];
    let page = 1;

    while (true) {
      const response = await this.client.get<GitLabDiscussion[]>(endpoint, {
        params: {
          page,
          per_page: 100,
        },
      });
      discussions.push(...response.data);

      const nextPage = Number(response.headers['x-next-page'] || 0);
      if (!nextPage) {
        break;
      }

      page = nextPage;
    }

    return discussions;
  }

  /**
   * 从 discussion 列表中挑出可安全删除的旧 AI note。
   *
   * 规则分两种：
   * 1. 整个 discussion 都是 AI note：可以整批删除
   * 2. discussion 里已经有人类回复：只能把 AI note 标记为过期，保留线程
   */
  private async extractAiCleanupCandidates(
    discussions: GitLabDiscussion[],
    channel: ReviewCommentChannel
  ): Promise<GitLabAiCleanupCandidate[]> {
    const currentUser = await this.getCurrentUser();
    const candidates: GitLabAiCleanupCandidate[] = [];

    for (const discussion of discussions) {
      const notes = (discussion.notes ?? []).filter((note) => !note.system);
      if (notes.length === 0) {
        continue;
      }

      const aiManagedNotes = notes.filter((note) => this.isManagedAiNote(note.body || '', currentUser, note.author, channel));
      if (aiManagedNotes.length === 0) {
        continue;
      }

      if (aiManagedNotes.length !== notes.length) {
        const staleNotes = aiManagedNotes.filter((note) => !this.isOutdatedAiNote(note.body || '', channel));
        if (staleNotes.length > 0) {
          candidates.push({
            discussionId: discussion.id,
            deletableNoteIds: [],
            staleNotes: staleNotes.map((note) => ({
              id: note.id,
              body: note.body || '',
            })),
          });
        }
        continue;
      }

      candidates.push({
        discussionId: discussion.id,
        deletableNoteIds: aiManagedNotes.map((note) => note.id),
        staleNotes: [],
      });
    }

    return candidates;
  }

  /**
   * 获取当前 API token 对应的 GitLab 用户，用于安全识别服务自己发出的评论。
   */
  private async getCurrentUser(): Promise<GitLabCurrentUserResponse | null> {
    if (!this.currentUserPromise) {
      this.currentUserPromise = this.fetchCurrentUser();
    }

    return this.currentUserPromise;
  }

  /**
   * 向 GitLab 查询当前鉴权用户信息。
   */
  private async fetchCurrentUser(): Promise<GitLabCurrentUserResponse | null> {
    try {
      const { data } = await this.client.get<GitLabCurrentUserResponse>('/user');
      return data;
    } catch (error: unknown) {
      logger.warn('Failed to fetch current GitLab user for AI comment cleanup', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * 判断一条 discussion note 是否属于本服务创建和维护的 AI 评论。
   *
   * 新版依赖隐藏 marker；旧版历史评论则通过特征正文兼容识别，保证升级后仍能清理干净。
   */
  private isManagedAiNote(
    body: string,
    currentUser: GitLabCurrentUserResponse | null,
    author: GitLabDiscussionAuthor | undefined,
    channel: ReviewCommentChannel
  ): boolean {
    const normalizedBody = body.trim();
    const commentMarker = this.getCommentMarker(channel);
    const hasMarker = normalizedBody.includes(commentMarker);
    const isLegacyAiShape = channel === 'ai-review'
      && (normalizedBody.startsWith('Token 消耗:') || normalizedBody.startsWith('💡 **['));

    if (!hasMarker && !isLegacyAiShape) {
      return false;
    }

    if (!currentUser) {
      return hasMarker || isLegacyAiShape;
    }

    return author?.id === currentUser.id
      || Boolean(currentUser.username && author?.username === currentUser.username);
  }

  /**
   * 给新发布的 AI 评论加上隐藏标记，便于后续安全清理旧评论。
   */
  private decorateAiCommentBody(body: string, channel: ReviewCommentChannel): string {
    const commentMarker = this.getCommentMarker(channel);
    if (body.includes(commentMarker)) {
      return body;
    }

    return `${commentMarker}\n${body}`;
  }

  /**
   * 判断当前 AI note 是否已经被标记为过期，避免重复更新。
   */
  private isOutdatedAiNote(body: string, channel: ReviewCommentChannel): boolean {
    return body.includes(this.getOutdatedMarker(channel));
  }

  /**
   * 为带有人类回复的旧 AI 评论追加“已过期”提示，而不是直接删除整条线程。
   *
   * 这样既能告诉读者这条评论针对的是旧代码，也不会抹掉后续人工讨论的语境。
   */
  private buildOutdatedAiCommentBody(body: string, channel: ReviewCommentChannel): string {
    if (this.isOutdatedAiNote(body, channel)) {
      return body;
    }

    const commentMarker = this.getCommentMarker(channel);
    const outdatedMarker = this.getOutdatedMarker(channel);
    const normalizedBody = body.trim();
    return [
      commentMarker,
      outdatedMarker,
      '> 此条 AI 评论来自旧版本代码，已过期，仅保留供追溯。',
      '',
      normalizedBody.replace(commentMarker, '').trim(),
    ].join('\n');
  }

  /**
   * 生成指定评论通道对应的隐藏标记，便于不同分析链路独立清理。
   */
  private getCommentMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_COMMENT_MARKER
      : `<!-- ai-review-server-comment:${channel} -->`;
  }

  /**
   * 生成指定评论通道对应的“已过期”标记。
   */
  private getOutdatedMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_OUTDATED_MARKER
      : `<!-- ai-review-server-outdated:${channel} -->`;
  }

  /**
   * 获取 Merge Request 最新一次 diff version 对应的 refs。
   *
   * 当 MR 主接口缺少完整 diff_refs 时，行级评论仍然依赖这组 refs 定位，因此需要
   * 额外回查 versions 列表并选取最新版本。
   */
  private async getLatestMergeRequestDiffRefs(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<ReviewDiffRefs> {
    const projectId = this.buildProjectId(target.owner, target.repo);
    const { data } = await this.client.get<GitLabMergeRequestVersion[]>(
      `/projects/${projectId}/merge_requests/${target.number}/versions`
    );

    const latestVersion = data.reduce<GitLabMergeRequestVersion | null>((latest, current) => {
      if (!latest || current.id > latest.id) {
        return current;
      }

      return latest;
    }, null);

    if (!latestVersion) {
      throw new ProviderError(`No GitLab diff version found for merge request !${target.number}`);
    }

    return {
      baseSha: latestVersion.base_commit_sha,
      startSha: latestVersion.start_commit_sha,
      headSha: latestVersion.head_commit_sha,
    };
  }

  /**
   * 把 GitLab diff_refs 结构标准化为内部使用的 diff ref 对象。
   */
  private normalizeDiffRefs(diffRefs: NonNullable<GitLabMergeRequestResponse['diff_refs']>): ReviewDiffRefs {
    return {
      baseSha: diffRefs.base_sha || '',
      startSha: diffRefs.start_sha || diffRefs.base_sha || '',
      headSha: diffRefs.head_sha || '',
    };
  }

  /**
   * 选择 commit review 使用的 baseSha，必要时回退到父提交。
   */
  private resolveBaseSha(baseSha: string, parentIds?: string[]): string {
    if (baseSha && !/^0+$/.test(baseSha)) {
      return baseSha;
    }

    return parentIds?.[0] || '';
  }

  /**
   * 把 GitLab 单文件 diff 条目转换成内部 FileDiff。
   */
  private parseDiffEntry(file: GitLabDiffEntry): FileDiff {
    const status = this.resolveDiffStatus(file);
    const parsedDiff = DiffParser.parsePatch(file.diff || '', file.new_path, status);
    parsedDiff.oldPath = file.old_path;

    return parsedDiff;
  }

  /**
   * 根据 GitLab diff 条目的标记判断文件变更类型。
   */
  private resolveDiffStatus(file: GitLabDiffEntry): FileDiff['status'] {
    if (file.new_file) {
      return 'added';
    }

    if (file.deleted_file) {
      return 'deleted';
    }

    if (file.renamed_file) {
      return 'renamed';
    }

    return 'modified';
  }

  /**
   * 通过 GitLab commit status 接口创建或更新状态记录。
   *
   * GitLab 的 status 模型本身就是“同名上下文反复更新”，所以 create/update 最终都落在
   * 同一个 API 上，provider 对上层暴露成统一的状态写入能力即可。
   */
  private async setCommitStatus(
    metadata: PullRequestMetadata,
    name: string,
    payload: ReviewCheckRunPayload | ReviewCheckRunUpdatePayload
  ): Promise<GitLabStatusResponse> {
    const projectId = this.buildProjectId(metadata.owner, metadata.repo);
    const { data } = await this.client.post<GitLabStatusResponse>(
      `/projects/${projectId}/statuses/${encodeURIComponent(metadata.headSha)}`,
      null,
      {
        params: {
          state: this.mapStatus(payload.status, payload.conclusion),
          name,
          ref: metadata.sourceBranch,
          target_url: payload.detailsUrl,
          description: this.buildStatusDescription(payload),
        },
      }
    );

    return data;
  }

  /**
   * 把内部 review 状态映射成 GitLab status state。
   */
  private mapStatus(
    status: ReviewCheckRunPayload['status'] | ReviewCheckRunUpdatePayload['status'],
    conclusion?: ReviewCheckConclusion
  ): string {
    if (status === 'queued') {
      return 'pending';
    }

    if (status === 'in_progress') {
      return 'running';
    }

    switch (conclusion) {
      case 'success':
        return 'success';
      case 'cancelled':
        return 'canceled';
      case 'neutral':
        return 'success';
      default:
        return 'failed';
    }
  }

  /**
   * 生成满足 GitLab 长度限制的状态描述文本。
   */
  private buildStatusDescription(payload: ReviewCheckRunPayload | ReviewCheckRunUpdatePayload): string {
    const description = payload.output.summary || payload.output.title;
    if (!description) {
      return 'AI review update';
    }

    return description.length > 255 ? `${description.slice(0, 252)}...` : description;
  }

  /**
   * 拼装 GitLab commit 页面链接。
   */
  private buildCommitUrl(owner: string, repo: string, sha: string): string {
    return `${this.webBaseUrl}/${owner}/${repo}/-/commit/${sha}`;
  }

  /**
   * 把 owner/repo 编码成 GitLab API 需要的 project id。
   */
  private buildProjectId(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }
}
