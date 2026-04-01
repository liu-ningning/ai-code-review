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
  // 评论清理阶段会频繁用到“当前 token 对应的是谁”，这里缓存一次即可，
  // 避免每轮同步评论都重复打 `/user` 接口。
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

    // GitHub 没有“整批替换 AI 评论”的原子接口，因此这里采用
    // “先清旧评论，再发新评论”的协调策略，尽量让同一轮 review 的输出保持一致。
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

      // GitHub code search 会分页返回结果，而且总量可能很大。
      // 这里主动限制最大页数和结果数，避免把 provider 变成高延迟的仓库遍历器。
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
      // 这里使用 commit status 而不是 GitHub Checks API。
      // 原因是实现更轻，且对个人仓库 / 简单 PAT 的兼容性更好。
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

  /**
   * 读取 Pull Request 元数据，并整理成主流程统一使用的描述对象。
   */
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

  /**
   * 读取单次 commit review 所需元数据。
   *
   * commit 模式没有 PR 的 base/head 语义，因此这里需要自己从父提交推导 baseSha，
   * 给后续 compare diff、checkout 和评论定位使用。
   */
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

  /**
   * 分页拉取 GitHub PR 文件变更列表，并只保留带 patch 的文本文件。
   *
   * GitHub 对二进制文件或超大 diff 可能不给 patch，此类文件会在这里自然跳过，
   * 避免后续 parser 面对空 patch 做无意义处理。
   */
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

  /**
   * 基于 compare 接口构造 commit review 模式下的 diff 列表。
   */
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

  /**
   * 把评论逐条发布成 GitHub PR review comment。
   *
   * 这里使用行级评论接口，因此要求 path/line/side 都尽量准确，否则 GitHub 会拒绝。
   */
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

  /**
   * 把评论逐条发布到 commit comments。
   *
   * commit 评论接口对行定位的容错更差，因此这里有一层降级策略：
   * 如果行级评论失败，就退回成普通 commit comment，至少保留 review 信息本身。
   */
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

  /**
   * 删除当前 PR 上由本服务创建的旧 AI 评论，避免多轮 review 累积噪音。
   */
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

  /**
   * 删除当前 commit 上由本服务创建的旧 AI 评论。
   */
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

  /**
   * 分页列出 PR 上所有 review comments，供清理逻辑复用。
   */
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

  /**
   * 分页列出 commit 上所有 comments，供清理逻辑复用。
   */
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

  /**
   * 根据隐藏 marker 和作者信息，删除当前通道下由本服务管理的旧评论。
   *
   * GitHub comment 一旦被删除就不可恢复，所以这里只清理“能明确确认属于本服务”的评论，
   * 避免误删人工评论或其他机器人留下的内容。
   */
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

  /**
   * 获取当前 token 对应的 GitHub 用户，并在 provider 生命周期内复用。
   */
  private async getCurrentUser(): Promise<GitHubCurrentUserResponse | null> {
    if (!this.currentUserPromise) {
      this.currentUserPromise = this.fetchCurrentUser();
    }

    return this.currentUserPromise;
  }

  /**
   * 实际请求 `/user`，失败时只影响清理精度，不阻断主 review 流程。
   */
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

  /**
   * 判断评论是否属于当前通道下由本服务写入的 AI 评论。
   *
   * 新评论依赖隐藏 marker 识别；同时保留对旧版本评论样式的兼容，
   * 这样历史遗留评论也能被新版本平滑清理。
   */
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

  /**
   * 给评论正文插入隐藏 marker，后续同步时据此识别和清理。
   */
  private decorateAiCommentBody(body: string, channel: ReviewCommentChannel): string {
    const commentMarker = this.getCommentMarker(channel);
    if (body.includes(commentMarker)) {
      return body;
    }

    return `${commentMarker}\n${body}`;
  }

  /**
   * 为不同评论通道生成独立 marker，避免多个分析链路互相误删评论。
   */
  private getCommentMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_COMMENT_MARKER
      : `<!-- ai-review-server-comment:${channel} -->`;
  }

  /**
   * 生成“已过期”marker。
   *
   * GitHub 当前实现没有把旧评论标过期，只是保留这个通道语义，方便与其他 SCM 保持一致。
   */
  private getOutdatedMarker(channel: ReviewCommentChannel): string {
    return channel === 'ai-review'
      ? AI_OUTDATED_MARKER
      : `<!-- ai-review-server-outdated:${channel} -->`;
  }

  /**
   * commit review 模式优先使用显式 baseSha；若调用方没给，则退回到第一个父提交。
   */
  private resolveBaseSha(baseSha: string, parentIds?: string[]): string {
    if (baseSha && !/^0+$/.test(baseSha)) {
      return baseSha;
    }

    return parentIds?.[0] || '';
  }

  /**
   * 把 GitHub 单文件 diff 条目转换成内部统一的 `FileDiff`。
   */
  private parseDiffEntry(file: GitHubPullRequestFile): FileDiff {
    const status = this.resolveDiffStatus(file.status);
    const parsed = DiffParser.parsePatch(file.patch || '', file.filename, status);
    parsed.oldPath = file.previous_filename;
    return parsed;
  }

  /**
   * 把 GitHub 文件状态映射到内部 diff 状态枚举。
   */
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

  /**
   * 使用 commit status API 表达 review 进度和结论。
   */
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

  /**
   * 把内部 review 生命周期状态映射到 GitHub 支持的 status state。
   */
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

  /**
   * 截断状态描述，满足 GitHub status description 长度限制。
   */
  private buildStatusDescription(payload: ReviewCheckRunPayload | ReviewCheckRunUpdatePayload): string {
    const description = payload.output.summary || payload.output.title || 'AI review update';
    return description.length > 140 ? `${description.slice(0, 137)}...` : description;
  }

  /**
   * 构造 commit 页面 URL，作为状态详情缺省跳转地址。
   */
  private buildCommitUrl(owner: string, repo: string, sha: string): string {
    return `${this.webBaseUrl}/${owner}/${repo}/commit/${sha}`;
  }

  /**
   * 对路径逐段编码，保留 `/` 分隔层级，兼容 GitHub contents API。
   */
  private encodePath(filePath: string): string {
    return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }
}
