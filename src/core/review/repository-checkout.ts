/**
 * 管理 review 过程中使用的仓库检出目录与镜像缓存。
 *
 * 这个文件负责维护裸仓库 mirror 缓存、按提交创建临时 worktree，
 * 并在多任务场景下通过仓库级锁避免重复拉取和并发竞争。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { LRUCache } from 'lru-cache';
import { config } from '../../config/index.js';
import { getErrorMessage } from '../../shared/error-utils.js';
import { logger } from '../../shared/logger.js';
import { GitClient } from './git-client.js';

const DEFAULT_FETCH_TTL_MS = 5 * 60 * 1000;

/**
 * 表示一次临时 checkout 结果及其清理能力。
 */
export interface RepositoryCheckout {
  rootDir: string;
  cleanup(): Promise<void>;
}

/**
 * 管理 PR 基线与 head 代码的本地镜像、checkout 和回收流程。
 */
export class RepositoryCheckoutManager {
  private static readonly lockTails = new Map<string, Promise<void>>();
  private static readonly mirrorFreshnessCache = new LRUCache<string, number>({
    max: 64,
    ttl: DEFAULT_FETCH_TTL_MS,
  });
  private static readonly commitPresenceCache = new LRUCache<string, true>({
    max: 4096,
    ttl: DEFAULT_FETCH_TTL_MS,
  });
  private readonly cacheRoot = path.join(os.tmpdir(), 'ai-review-repo-cache');
  private readonly gitClient = new GitClient({
    token: config.SCM_TYPE === 'github' ? config.GITHUB_TOKEN : config.GITLAB_TOKEN,
    scmType: config.SCM_TYPE,
  });

  /**
   * 为指定仓库和目标提交准备本地 checkout，并返回可清理句柄。
   */
  async checkout(owner: string, repo: string, branch: string, headSha?: string): Promise<RepositoryCheckout> {
    const repoKey = `${owner}/${repo}`;

    return this.withRepoLock(repoKey, async () => {
      await mkdir(this.cacheRoot, { recursive: true });

      const mirrorDir = path.join(this.cacheRoot, this.toCacheDirectoryName(repoKey));
      const repoUrl = this.buildRepositoryUrl(owner, repo);

      await this.ensureMirror(mirrorDir, repoUrl);
      await this.ensureFreshMirror(mirrorDir, repoUrl, branch, headSha);

      const checkoutDir = await mkdtemp(path.join(os.tmpdir(), 'ai-review-checkout-'));
      const checkoutRef = await this.resolveCheckoutRef(mirrorDir, branch, headSha);
      await this.gitClient.addDetachedWorktree(mirrorDir, checkoutDir, checkoutRef);

      logger.info(`Prepared repository checkout for ${repoKey}`, {
        branch,
        headSha,
        checkoutRef,
      });

      return {
        rootDir: checkoutDir,
        cleanup: async () => {
          try {
            await this.gitClient.removeWorktree(mirrorDir, checkoutDir);
          } catch (error: unknown) {
            logger.warn(`Failed to remove worktree for ${repoKey}: ${getErrorMessage(error)}`);
          }

          await rm(checkoutDir, { force: true, recursive: true });
        },
      };
    });
  }

  /**
   * 针对同一个仓库串行化镜像刷新与 worktree 创建，避免并发冲突。
   */
  private async withRepoLock<T>(repoKey: string, task: () => Promise<T>): Promise<T> {
    const previousTail = RepositoryCheckoutManager.lockTails.get(repoKey) ?? Promise.resolve();
    let releaseLock!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    RepositoryCheckoutManager.lockTails.set(repoKey, currentTail);
    await previousTail.catch(() => undefined);

    try {
      return await task();
    } finally {
      releaseLock();
      if (RepositoryCheckoutManager.lockTails.get(repoKey) === currentTail) {
        RepositoryCheckoutManager.lockTails.delete(repoKey);
      }
    }
  }

  /**
   * 确保本地 mirror 仓库存在；若已存在则校正 origin 地址。
   */
  private async ensureMirror(mirrorDir: string, repoUrl: string): Promise<void> {
    try {
      await stat(mirrorDir);
    } catch {
      logger.info(`Cloning mirror repository into cache: ${mirrorDir}`);
      await this.gitClient.cloneMirror(repoUrl, mirrorDir);
      RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
      return;
    }

    await this.gitClient.setRemoteUrl(mirrorDir, 'origin', repoUrl);
  }

  /**
   * 在缓存过期或目标提交缺失时刷新 mirror，并按需补抓指定 head。
   */
  private async ensureFreshMirror(
    mirrorDir: string,
    repoUrl: string,
    branch: string,
    headSha?: string
  ): Promise<void> {
    const needsRefresh = await this.shouldRefreshMirror(mirrorDir);
    const hasHeadSha = headSha ? await this.hasCommit(mirrorDir, headSha) : true;

    if (!needsRefresh && hasHeadSha) {
      return;
    }

    logger.info(`Fetching repository mirror for ${repoUrl}`, {
      branch,
      headSha,
    });

    await this.gitClient.fetchOrigin(mirrorDir);
    RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
    this.clearCommitPresenceEntries(mirrorDir);

    if (headSha && !(await this.hasCommit(mirrorDir, headSha))) {
      await this.gitClient.fetchRef(mirrorDir, 'origin', headSha);
      RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
    }
  }

  /**
   * 判断当前 mirror 是否已经足够新鲜，可以跳过远端 fetch。
   */
  private async shouldRefreshMirror(mirrorDir: string): Promise<boolean> {
    if (RepositoryCheckoutManager.mirrorFreshnessCache.has(mirrorDir)) {
      return false;
    }

    try {
      const fetchHead = await stat(path.join(mirrorDir, 'FETCH_HEAD'));
      const isFresh = Date.now() - fetchHead.mtimeMs <= DEFAULT_FETCH_TTL_MS;
      if (isFresh) {
        RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, fetchHead.mtimeMs);
      }

      return !isFresh;
    } catch {
      return true;
    }
  }

  /**
   * 选择本次 checkout 应该使用的 ref，优先 headSha，其次远端分支引用。
   */
  private async resolveCheckoutRef(mirrorDir: string, branch: string, headSha?: string): Promise<string> {
    if (headSha && await this.hasCommit(mirrorDir, headSha)) {
      return headSha;
    }

    const remoteBranchRef = `refs/remotes/origin/${branch}`;
    if (await this.hasCommit(mirrorDir, remoteBranchRef)) {
      return remoteBranchRef;
    }

    return branch;
  }

  /**
   * 带缓存地判断 mirror 里是否已经存在某个提交或引用。
   */
  private async hasCommit(mirrorDir: string, ref: string): Promise<boolean> {
    const cacheKey = `${mirrorDir}:${ref}`;
    if (RepositoryCheckoutManager.commitPresenceCache.has(cacheKey)) {
      return true;
    }

    const hasCommit = await this.gitClient.hasCommit(mirrorDir, ref);
    if (!hasCommit) {
      return false;
    }

    RepositoryCheckoutManager.commitPresenceCache.set(cacheKey, true);
    return true;
  }

  /**
   * 在 mirror 刷新后清理该仓库对应的提交存在性缓存。
   */
  private clearCommitPresenceEntries(mirrorDir: string): void {
    const keyPrefix = `${mirrorDir}:`;
    for (const cacheKey of RepositoryCheckoutManager.commitPresenceCache.keys()) {
      if (cacheKey.startsWith(keyPrefix)) {
        RepositoryCheckoutManager.commitPresenceCache.delete(cacheKey);
      }
    }
  }

  /**
   * 组装用于 git clone/fetch 的远端仓库地址。
   */
  private buildRepositoryUrl(owner: string, repo: string): string {
    const repoPath = `${owner}/${repo}`
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    const webBaseUrl = config.SCM_TYPE === 'github'
      ? config.GITHUB_WEB_BASE_URL
      : config.GITLAB_BASE_URL;

    return `${webBaseUrl.replace(/\/$/, '')}/${repoPath}.git`;
  }

  /**
   * 把仓库 key 转成适合作为本地缓存目录名的形式。
   */
  private toCacheDirectoryName(repoKey: string): string {
    return `${repoKey.replace(/[^\w.-]+/g, '__')}.git`;
  }
}
