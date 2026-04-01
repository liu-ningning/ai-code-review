/**
 * 提供面向 GitHub REST API 的 SCM 能力实现。
 *
 * 这个文件负责获取 Pull Request 或 commit 元数据、读取 diff 与文件内容、
 * 回写评论，以及同步 review 状态到 GitHub commit status。
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
  ReviewComment,
  ReviewCommentChannel,
  ReviewCommentSyncOptions,
  ReviewCommentSyncResult,
  ReviewDiffRefs,
  ReviewTarget,
} from '../../types/index.js';
import { ProviderError } from '../../shared/errors.js';
import { getErrorMessage } from '../../shared/error-utils.js';
import { logger } from '../../shared/logger.js';
import { DiffParser } from './diff-parser.js';

interface GitHubProviderOptions {
  token?: string;
  apiBaseUrl: string;
  webBaseUrl: string;
}

interface GitHubUserRef {
  id?: number;
  login?: string;
}

interface GitHubPullRequestResponse {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  user?: GitHubUserRef | null;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
}

interface GitHubCommitResponse {
  sha: string;
  html_url?: string;
  parents?: Array<{ sha: string }>;
  commit?: {
    author?: { name?: string | null };
    message?: string | null;
  };
  author?: GitHubUserRef | null;
}

interface GitHubPullRequestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

interface GitHubCompareResponse {
  files?: GitHubPullRequestFile[];
}

interface GitHubSearchResponse {
  total_count?: number;
  items?: Array<{ path?: string }>;
}

interface GitHubCurrentUserResponse {
  id: number;
  login?: string;
}

interface GitHubIssueComment {
  id: number;
  body?: string;
  user?: GitHubUserRef | null;
}

const AI_COMMENT_MARKER = '<!-- ai-review-server-comment -->';
const AI_OUTDATED_MARKER = '<!-- ai-review-server-outdated -->';
const SEARCH_RESULTS_PER_PAGE = 100;
const MAX_SEARCH_PAGES = 5;
const MAX_SEARCH_RESULTS = 200;

/**
 * 基于 GitHub REST API 实现 review 服务所需的 SCM 操作。
 */
export class GitHubProvider implements ISCMProvider {
  private readonly client: AxiosInstance;
  private readonly webBaseUrl: string;
  private currentUserPromise: Promise<GitHubCurrentUserResponse | null> | null = null;

  constructor(options: GitHubProviderOptions) {
    if (!options.token) {
      throw new ProviderError('GitHub authentication is not configured');
    }

    this.webBaseUrl = options.webBaseUrl.replace(/\/$/, '');
    this.client = axios.create({
      baseURL: options.apiBaseUrl.replace(/\/$/, ''),
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 30_000,
    });
  }

  async getReviewMetadata(target: ReviewTarget): Promise<PullRequestMetadata> {
    if (target.kind === 'merge_request') {
      return this.getPullRequestMetadata(target);
    }

    return this.getCommitMetadata(target);
  }

  async getDiff(target: ReviewTarget, metadata: PullRequestMetadata): Promise<FileDiff[]> {
    if (target.kind === 'merge_request') {
      return this.getPullRequestDiff(target);
    }

    return this.getCommitDiff(target, metadata);
  }

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

    if (target.kind === 'merge_request') {
      const cleanupResult = await this.clearExistingPullRequestAiComments(target, channel);
      syncResult.deletedCount += cleanupResult.deletedCount;
      syncResult.outdatedCount += cleanupResult.outdatedCount;
      syncResult.failedCount += cleanupResult.failedCount;

      const postResult = await this.postPullRequestComments(target, metadata, comments, channel);
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

  async getFileContent(owner: string, repo: string, filePath: string, ref: string): Promise<string> {
    try {
      const response = await this.client.get<string>(
        `/repos/${owner}/${repo}/contents/${this.encodePath(filePath)}`,
        {
          params: { ref },
          headers: {
            Accept: 'application/vnd.github.raw+json',
          },
          responseType: 'text',
        }
      );

      return typeof response.data === 'string' ? response.data : String(response.data ?? '');
    } catch (error: unknown) {
      const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (statusCode === 404) {
        logger.debug(`GitHub file content lookup missed: ${filePath}@${ref}`);
        return '';
      }

      logger.error(`Failed to fetch GitHub file content: ${filePath}@${ref}`, {
        error: getErrorMessage(error),
        statusCode,
      });
      return '';
    }
  }

  async searchCode(owner: string, repo: string, query: string): Promise<string[]> {
    try {
      const results = new Set<string>();

      for (let page = 1; page <= MAX_SEARCH_PAGES && results.size < MAX_SEARCH_RESULTS; page += 1) {
        const { data } = await this.client.get<GitHubSearchResponse>('/search/code', {
          params: {
            q: `${query} repo:${owner}/${repo}`,
            page,
            per_page: SEARCH_RESULTS_PER_PAGE,
          },
        });

        for (const item of data.items ?? []) {
          const candidatePath = item.path?.trim();
          if (!candidatePath) {
            continue;
          }

          results.add(candidatePath);
          if (results.size >= MAX_SEARCH_RESULTS) {
            break;
          }
        }

        const totalCount = Number(data.total_count ?? 0);
        if (totalCount > 0 && page * SEARCH_RESULTS_PER_PAGE >= totalCount) {
          break;
        }

        if (totalCount <= 0 && (data.items?.length ?? 0) < SEARCH_RESULTS_PER_PAGE) {
          break;
        }
      }

      return Array.from(results);
    } catch (error: unknown) {
      logger.error(`GitHub search failed for: ${query}`, {
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  async createReviewStatus(
    metadata: PullRequestMetadata,
    payload: ReviewCheckRunPayload
  ): Promise<ReviewCheckRun | null> {
    try {
      await this.setCommitStatus(metadata, payload.name, payload);
      return {
        id: Date.now(),
        url: payload.detailsUrl,
        name: payload.name,
      };
    } catch (error: unknown) {
      logger.warn(`Failed to create GitHub review status for ${metadata.owner}/${metadata.repo}`, {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async updateReviewStatus(
    metadata: PullRequestMetadata,
    checkRun: ReviewCheckRun,
    payload: ReviewCheckRunUpdatePayload
  ): Promise<void> {
    try {
      await this.setCommitStatus(metadata, checkRun.name || 'AI Review', payload);
    } catch (error: unknown) {
      logger.warn(`Failed to update GitHub review status for ${metadata.owner}/${metadata.repo}`, {
        error: getErrorMessage(error),
      });
    }
  }

  private async getPullRequestMetadata(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<PullRequestMetadata> {
    try {
      const { data } = await this.client.get<GitHubPullRequestResponse>(
        `/repos/${target.owner}/${target.repo}/pulls/${target.number}`
      );
      const diffRefs: ReviewDiffRefs = {
        baseSha: data.base.sha,
        startSha: data.base.sha,
        headSha: data.head.sha,
      };

      return {
        id: String(data.id),
        number: data.number,
        title: data.title,
        description: data.body || '',
        htmlUrl: data.html_url,
        owner: target.owner,
        repo: target.repo,
        sourceBranch: data.head.ref,
        headSha: data.head.sha,
        targetBranch: data.base.ref,
        author: data.user?.login || 'unknown',
        kind: 'merge_request',
        displayId: `#${data.number}`,
        baseSha: data.base.sha,
        diffRefs,
      };
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitHub pull request: ${getErrorMessage(error)}`, error);
    }
  }

  private async getCommitMetadata(
    target: Extract<ReviewTarget, { kind: 'commit' }>
  ): Promise<PullRequestMetadata> {
    try {
      const { data } = await this.client.get<GitHubCommitResponse>(
        `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(target.headSha)}`
      );
      const baseSha = this.resolveBaseSha(target.baseSha, data.parents?.map((item) => item.sha));
      const shortSha = target.headSha.slice(0, 8);
      const message = data.commit?.message || '';
      const title = message.split('\n')[0]?.trim() || `Review commit ${shortSha}`;

      return {
        id: data.sha,
        title: target.title || title,
        description: target.description || message || `Push review for ${target.branch}`,
        htmlUrl: target.htmlUrl || data.html_url || this.buildCommitUrl(target.owner, target.repo, target.headSha),
        owner: target.owner,
        repo: target.repo,
        sourceBranch: target.branch,
        headSha: target.headSha,
        targetBranch: target.branch,
        author: target.author || data.author?.login || data.commit?.author?.name || 'unknown',
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
      throw new ProviderError(`Failed to fetch GitHub commit: ${getErrorMessage(error)}`, error);
    }
  }

  private async getPullRequestDiff(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<FileDiff[]> {
    const files: GitHubPullRequestFile[] = [];

    try {
      for (let page = 1; ; page += 1) {
        const { data } = await this.client.get<GitHubPullRequestFile[]>(
          `/repos/${target.owner}/${target.repo}/pulls/${target.number}/files`,
          {
            params: {
              page,
              per_page: 100,
            },
          }
        );
        files.push(...data);
        if (data.length < 100) {
          break;
        }
      }

      return files
        .filter((file) => typeof file.patch === 'string' && file.patch.trim())
        .map((file) => this.parseDiffEntry(file));
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitHub pull request diff: ${getErrorMessage(error)}`, error);
    }
  }

  private async getCommitDiff(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    metadata: PullRequestMetadata
  ): Promise<FileDiff[]> {
    const baseSha = metadata.baseSha || target.baseSha;
    if (!baseSha || baseSha === target.headSha) {
      return [];
    }

    try {
      const { data } = await this.client.get<GitHubCompareResponse>(
        `/repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(target.headSha)}`
      );

      return (data.files ?? [])
        .filter((file) => typeof file.patch === 'string' && file.patch.trim())
        .map((file) => this.parseDiffEntry(file));
    } catch (error: unknown) {
      throw new ProviderError(`Failed to fetch GitHub compare diff: ${getErrorMessage(error)}`, error);
    }
  }

  private async postPullRequestComments(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>,
    metadata: PullRequestMetadata,
    comments: ReviewComment[],
    channel: ReviewCommentChannel
  ): Promise<{ postedCount: number; failedCount: number }> {
    let postedCount = 0;
    let failedCount = 0;

    for (const comment of comments) {
      try {
        await this.client.post(
          `/repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`,
          {
            body: this.decorateAiCommentBody(comment.body, channel),
            commit_id: metadata.headSha,
            path: comment.path,
            line: comment.line,
            side: comment.side,
          }
        );
        postedCount += 1;
      } catch (error: unknown) {
        failedCount += 1;
        logger.warn(`Failed to post GitHub PR comment for ${target.owner}/${target.repo}#${target.number}`, {
          error: getErrorMessage(error),
          line: comment.line,
          path: comment.path,
        });
      }
    }

    return { postedCount, failedCount };
  }

  private async postCommitComments(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    comments: ReviewComment[],
    channel: ReviewCommentChannel
  ): Promise<{ postedCount: number; failedCount: number }> {
    let postedCount = 0;
    let failedCount = 0;

    for (const comment of comments) {
      try {
        await this.client.post(
          `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(target.headSha)}/comments`,
          {
            body: this.decorateAiCommentBody(comment.body, channel),
            path: comment.path,
            line: comment.line,
            side: comment.side,
          }
        );
        postedCount += 1;
      } catch (error: unknown) {
        try {
          await this.client.post(
            `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(target.headSha)}/comments`,
            {
              body: this.decorateAiCommentBody(
                `${comment.path}:${comment.line}\n\n${comment.body}`,
                channel
              ),
            }
          );
          postedCount += 1;
        } catch (fallbackError: unknown) {
          failedCount += 1;
          logger.warn(`Failed to post GitHub commit comment for ${target.owner}/${target.repo}@${target.headSha}`, {
            error: getErrorMessage(fallbackError),
            line: comment.line,
            path: comment.path,
          });
        }
      }
    }

    return { postedCount, failedCount };
  }

  private async clearExistingPullRequestAiComments(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>,
    channel: ReviewCommentChannel
  ): Promise<{ deletedCount: number; outdatedCount: number; failedCount: number }> {
    const comments = await this.listAllPullRequestComments(target);
    return this.deleteManagedComments(
      comments,
      channel,
      async (commentId) => {
        await this.client.delete(`/repos/${target.owner}/${target.repo}/pulls/comments/${commentId}`);
      }
    );
  }

  private async clearExistingCommitAiComments(
    target: Extract<ReviewTarget, { kind: 'commit' }>,
    channel: ReviewCommentChannel
  ): Promise<{ deletedCount: number; outdatedCount: number; failedCount: number }> {
    const comments = await this.listAllCommitComments(target);
    return this.deleteManagedComments(
      comments,
      channel,
      async (commentId) => {
        await this.client.delete(`/repos/${target.owner}/${target.repo}/comments/${commentId}`);
      }
    );
  }

  private async listAllPullRequestComments(
    target: Extract<ReviewTarget, { kind: 'merge_request' }>
  ): Promise<GitHubIssueComment[]> {
    const comments: GitHubIssueComment[] = [];

    for (let page = 1; ; page += 1) {
      const { data } = await this.client.get<GitHubIssueComment[]>(
        `/repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`,
        {
          params: {
            page,
            per_page: 100,
          },
        }
      );
      comments.push(...data);
      if (data.length < 100) {
        break;
      }
    }

    return comments;
  }

  private async listAllCommitComments(
    target: Extract<ReviewTarget, { kind: 'commit' }>
  ): Promise<GitHubIssueComment[]> {
    const comments: GitHubIssueComment[] = [];

    for (let page = 1; ; page += 1) {
      const { data } = await this.client.get<GitHubIssueComment[]>(
        `/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(target.headSha)}/comments`,
        {
          params: {
            page,
            per_page: 100,
          },
        }
      );
      comments.push(...data);
      if (data.length < 100) {
        break;
      }
    }

    return comments;
  }

  private async deleteManagedComments(
    comments: GitHubIssueComment[],
    channel: ReviewCommentChannel,
    deleter: (commentId: number) => Promise<void>
  ): Promise<{ deletedCount: number; outdatedCount: number; failedCount: number }> {
    const currentUser = await this.getCurrentUser();
    let deletedCount = 0;
    let failedCount = 0;

    for (const comment of comments) {
      if (!this.isManagedAiComment(comment.body || '', currentUser, comment.user, channel)) {
        continue;
      }

      try {
        await deleter(comment.id);
        deletedCount += 1;
      } catch (error: unknown) {
        failedCount += 1;
        logger.warn('Failed to delete stale GitHub AI comment', {
          error: getErrorMessage(error),
          commentId: comment.id,
        });
      }
    }

    return {
      deletedCount,
      outdatedCount: 0,
      failedCount,
    };
  }

  private async getCurrentUser(): Promise<GitHubCurrentUserResponse | null> {
    if (!this.currentUserPromise) {
      this.currentUserPromise = this.fetchCurrentUser();
    }

    return this.currentUserPromise;
  }

  private async fetchCurrentUser(): Promise<GitHubCurrentUserResponse | null> {
    try {
      const { data } = await this.client.get<GitHubCurrentUserResponse>('/user');
      return data;
    } catch (error: unknown) {
      logger.warn('Failed to fetch current GitHub user for AI comment cleanup', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private isManagedAiComment(
    body: string,
    currentUser: GitHubCurrentUserResponse | null,
    author: GitHubUserRef | null | undefined,
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
      return true;
    }

    return author?.id === currentUser.id
      || Boolean(currentUser.login && author?.login === currentUser.login);
  }

  private decorateAiCommentBody(body: string, channel: ReviewCommentChannel): string {
    const commentMarker = this.getCommentMarker(channel);
    if (body.includes(commentMarker)) {
      return body;
    }

    return `${commentMarker}\n${body}`;
  }

  private getCommentMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_COMMENT_MARKER
      : `<!-- ai-review-server-comment:${channel} -->`;
  }

  private getOutdatedMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_OUTDATED_MARKER
      : `<!-- ai-review-server-outdated:${channel} -->`;
  }

  private resolveBaseSha(baseSha: string, parentIds?: string[]): string {
    if (baseSha && !/^0+$/.test(baseSha)) {
      return baseSha;
    }

    return parentIds?.[0] || '';
  }

  private parseDiffEntry(file: GitHubPullRequestFile): FileDiff {
    const status = this.resolveDiffStatus(file.status);
    const parsed = DiffParser.parsePatch(file.patch || '', file.filename, status);
    parsed.oldPath = file.previous_filename;
    return parsed;
  }

  private resolveDiffStatus(status: string): FileDiff['status'] {
    switch (status) {
      case 'added':
        return 'added';
      case 'removed':
        return 'deleted';
      case 'renamed':
        return 'renamed';
      default:
        return 'modified';
    }
  }

  private async setCommitStatus(
    metadata: PullRequestMetadata,
    name: string,
    payload: ReviewCheckRunPayload | ReviewCheckRunUpdatePayload
  ): Promise<void> {
    await this.client.post(
      `/repos/${metadata.owner}/${metadata.repo}/statuses/${encodeURIComponent(metadata.headSha)}`,
      {
        state: this.mapStatus(payload.status, payload.conclusion),
        target_url: payload.detailsUrl,
        description: this.buildStatusDescription(payload),
        context: name,
      }
    );
  }

  private mapStatus(
    status: ReviewCheckRunPayload['status'] | ReviewCheckRunUpdatePayload['status'],
    conclusion?: ReviewCheckConclusion
  ): 'pending' | 'success' | 'failure' | 'error' {
    if (status === 'queued' || status === 'in_progress') {
      return 'pending';
    }

    switch (conclusion) {
      case 'success':
        return 'success';
      case 'neutral':
        return 'success';
      case 'cancelled':
        return 'error';
      default:
        return 'failure';
    }
  }

  private buildStatusDescription(payload: ReviewCheckRunPayload | ReviewCheckRunUpdatePayload): string {
    const description = payload.output.summary || payload.output.title || 'AI review update';
    return description.length > 140 ? `${description.slice(0, 137)}...` : description;
  }

  private buildCommitUrl(owner: string, repo: string, sha: string): string {
    return `${this.webBaseUrl}/${owner}/${repo}/commit/${sha}`;
  }

  private encodePath(filePath: string): string {
    return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }
}
