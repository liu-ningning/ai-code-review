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
import { SCMType } from '../../types/index.js';
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
  // 每个仓库一把逻辑锁，保证 mirror 刷新和 worktree 创建不会并发互踩。
  // 这里不用更重的外部锁，是因为当前服务模型主要是单进程内并发；
  // 对同仓库串行化已经能解决大多数“fetch 正在执行时另一个任务也在改 mirror”的问题。
  private static readonly lockTails = new Map<string, Promise<void>>();
  // mirror 最近一次成功 fetch 的新鲜度缓存。
  // 这层缓存的目的不是保证绝对一致，而是减少短时间内重复 review 同一仓库时
  // 不必要的远端 fetch，降低 SCM API 和 git 远端压力。
  private static readonly mirrorFreshnessCache = new LRUCache<string, number>({
    max: 64,
    ttl: DEFAULT_FETCH_TTL_MS,
  });
  // 提交存在性缓存和 freshness 缓存分开维护：
  // - freshness 解决“要不要 fetch”
  // - commit presence 解决“某个 sha/ref 当前 mirror 里是否已经存在”
  // 这样可以避免每次选 checkoutRef 都执行一次 rev-parse。
  private static readonly commitPresenceCache = new LRUCache<string, true>({
    max: 4096,
    ttl: DEFAULT_FETCH_TTL_MS,
  });
  private readonly cacheRoot = path.join(os.tmpdir(), 'ai-review-repo-cache');
  /**
   * 为指定仓库和目标提交准备本地 checkout，并返回可清理句柄。
   */
  async checkout(
    owner: string,
    repo: string,
    branch: string,
    headSha?: string,
    scmType: SCMType = config.SCM_TYPE
  ): Promise<RepositoryCheckout> {
    const repoKey = `${owner}/${repo}`;
    // gitClient 按“本次请求实际选择的平台”构造，而不是读全局默认值。
    // 这样同一个服务实例才能在 GitHub / GitLab 间按请求切换。
    const gitClient = this.createGitClient(scmType);

    return this.withRepoLock(repoKey, async () => {
      // checkout 流程固定为：
      // 1. 确保 mirror 存在
      // 2. 视情况刷新远端
      // 3. 选择合适 ref
      // 4. 创建 detached worktree
      await mkdir(this.cacheRoot, { recursive: true });

      const mirrorDir = path.join(this.cacheRoot, this.toCacheDirectoryName(repoKey));
      const repoUrl = this.buildRepositoryUrl(owner, repo, scmType);

      await this.ensureMirror(gitClient, mirrorDir, repoUrl);
      await this.ensureFreshMirror(gitClient, mirrorDir, repoUrl, branch, headSha);

      const checkoutDir = await mkdtemp(path.join(os.tmpdir(), 'ai-review-checkout-'));
      const checkoutRef = await this.resolveCheckoutRef(gitClient, mirrorDir, branch, headSha);
      await gitClient.addDetachedWorktree(mirrorDir, checkoutDir, checkoutRef);

      logger.info(`Prepared repository checkout for ${repoKey}`, {
        branch,
        headSha,
        checkoutRef,
      });

      return {
        rootDir: checkoutDir,
        cleanup: async () => {
          // worktree remove 失败不应阻断主流程结束；只记录警告并尽量清掉物理目录。
          // 否则 review 已完成但因为临时目录回收失败导致整次任务报错，收益很低。
          try {
            await gitClient.removeWorktree(mirrorDir, checkoutDir);
          } catch (error: unknown) {
            logger.warn(`⚠️ Failed to remove worktree for ${repoKey}: ${getErrorMessage(error)}`);
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
   *
   * 即使 mirror 已存在，也要同步 origin 地址，避免仓库域名或来源变更后继续使用旧地址。
   */
  private async ensureMirror(gitClient: GitClient, mirrorDir: string, repoUrl: string): Promise<void> {
    try {
      await stat(mirrorDir);
    } catch {
      logger.info(`Cloning mirror repository into cache: ${mirrorDir}`);
      await gitClient.cloneMirror(repoUrl, mirrorDir);
      RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
      return;
    }

    // 如果缓存目录存在但不是有效的 bare repo，说明上次 clone/fetch 过程被打断
    // 或目录被外部污染。这里直接清理并重建，避免后续 remote/fetch/worktree 全部失败。
    if (!(await gitClient.isBareRepository(mirrorDir))) {
      logger.warn(`⚠️ Mirror cache is invalid, rebuilding repository cache: ${mirrorDir}`);
      await rm(mirrorDir, { force: true, recursive: true });
      RepositoryCheckoutManager.mirrorFreshnessCache.delete(mirrorDir);
      this.clearCommitPresenceEntries(mirrorDir);
      await gitClient.cloneMirror(repoUrl, mirrorDir);
      RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
      return;
    }

    await gitClient.setRemoteUrl(mirrorDir, 'origin', repoUrl);
  }

  /**
   * 在缓存过期或目标提交缺失时刷新 mirror，并按需补抓指定 head。
   */
  private async ensureFreshMirror(
    gitClient: GitClient,
    mirrorDir: string,
    repoUrl: string,
    branch: string,
    headSha?: string
  ): Promise<void> {
    const needsRefresh = await this.shouldRefreshMirror(mirrorDir);
    const hasHeadSha = headSha ? await this.hasCommit(gitClient, mirrorDir, headSha) : true;

    // 只有在“缓存过旧”或“目标提交缺失”两类情况下才真的访问远端。
    // 这能把大部分重复 review 压缩成纯本地路径。
    if (!needsRefresh && hasHeadSha) {
      return;
    }

    logger.info(`Fetching repository mirror for ${repoUrl}`, {
      branch,
      headSha,
    });

    await gitClient.fetchOrigin(mirrorDir);
    RepositoryCheckoutManager.mirrorFreshnessCache.set(mirrorDir, Date.now());
    // refresh 之后，之前的 commit presence 判断可能已经过期，需要整体清掉。
    this.clearCommitPresenceEntries(mirrorDir);

    // 某些场景下 origin fetch 后目标 sha 仍不在本地，例如 review 指向了一个非常新的提交
    // 或远端分支引用还没完全覆盖该对象，此时再按 sha 显式补抓一次。
    if (headSha && !(await this.hasCommit(gitClient, mirrorDir, headSha))) {
      await gitClient.fetchRef(mirrorDir, 'origin', headSha);
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
      // 对 bare mirror 来说，FETCH_HEAD 是否足够新鲜已经能很好地代表“近期是否 fetch 过”。
      // 不需要每次都真的访问远端问一遍。
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
   *
   * 优先精确 headSha 能避免分支指针在 review 执行期间继续移动造成的不确定性。
   */
  private async resolveCheckoutRef(gitClient: GitClient, mirrorDir: string, branch: string, headSha?: string): Promise<string> {
    // checkoutRef 的选择优先级体现了“精确性优先”：
    // 1. 优先 headSha，保证 review 对象稳定
    // 2. 退化到远端分支引用
    // 3. 再退化到裸 branch 名，让 git 自己解析
    if (headSha && await this.hasCommit(gitClient, mirrorDir, headSha)) {
      return headSha;
    }

    const remoteBranchRef = `refs/remotes/origin/${branch}`;
    if (await this.hasCommit(gitClient, mirrorDir, remoteBranchRef)) {
      return remoteBranchRef;
    }

    return branch;
  }

  /**
   * 带缓存地判断 mirror 里是否已经存在某个提交或引用。
   */
  private async hasCommit(gitClient: GitClient, mirrorDir: string, ref: string): Promise<boolean> {
    const cacheKey = `${mirrorDir}:${ref}`;
    if (RepositoryCheckoutManager.commitPresenceCache.has(cacheKey)) {
      return true;
    }

    const hasCommit = await gitClient.hasCommit(mirrorDir, ref);
    if (!hasCommit) {
      return false;
    }

    RepositoryCheckoutManager.commitPresenceCache.set(cacheKey, true);
    return true;
  }

  /**
   * 在 mirror 刷新后清理该仓库对应的提交存在性缓存。
   *
   * commitPresenceCache 的 key 都带 mirrorDir 前缀，因此按前缀删除即可。
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
   *
   * owner 可能本身包含 group/subgroup，需要逐段编码再拼回去。
   */
  private buildRepositoryUrl(owner: string, repo: string, scmType: SCMType): string {
    const repoPath = `${owner}/${repo}`
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    // 这里统一基于 Web 根地址拼 `.git` 仓库 URL。
    // GitHub / GitLab 在 HTTP clone 形式上兼容，因此不需要 provider 再分别拼装。
    const webBaseUrl = scmType === 'github'
      ? config.GITHUB_WEB_BASE_URL
      : config.GITLAB_BASE_URL;

    return `${webBaseUrl.replace(/\/$/, '')}/${repoPath}.git`;
  }

  /**
   * 把仓库 key 转成适合作为本地缓存目录名的形式。
   *
   * 目录名只保留安全字符，避免斜杠和特殊符号破坏缓存结构。
   */
  private toCacheDirectoryName(repoKey: string): string {
    return `${repoKey.replace(/[^\w.-]+/g, '__')}.git`;
  }

  /**
   * 按本次 review 使用的 SCM 类型创建对应的 git 认证客户端。
   */
  private createGitClient(scmType: SCMType): GitClient {
    return new GitClient({
      token: scmType === 'github' ? config.GITHUB_TOKEN : config.GITLAB_TOKEN,
      scmType,
    });
  }
}
