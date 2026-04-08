/**
 * 封装 review 服务运行时需要的 git 命令调用。
 *
 * 这个文件负责把 clone、fetch、worktree、ref 校验等底层 git
 * 操作收敛到一个客户端里，并统一处理认证参数和 git 缺失错误。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorCode } from '../../shared/error-utils.js';

const execFileAsync = promisify(execFile);
const GIT_NOT_FOUND_MESSAGE =
  'git executable is required at runtime but was not found in PATH. Install git in the deployment environment.';

/**
 * Git 客户端构造参数，目前主要承载可选的访问 token。
 */
export interface GitClientOptions {
  token?: string;
  // 不同平台在 git over HTTP 的 Basic 用户名占位不同，
  // 因此这里把 scmType 显式传入，而不是只传 token。
  scmType?: 'gitlab' | 'github';
}

/**
 * 对 git 命令做轻量封装，统一 checkout、diff、fetch 等操作。
 */
export class GitClient {
  /**
   * 创建 git 客户端，并注入可选的 SCM 访问 token。
   */
  constructor(private readonly options: GitClientOptions = {}) {}

  /**
   * 检查运行环境里是否存在可执行的 git 命令。
   */
  async assertAvailable(): Promise<void> {
    try {
      await execFileAsync('git', ['--version']);
    } catch (error: unknown) {
      this.rethrowIfGitMissing(error);
      throw error;
    }
  }

  /**
   * 以 mirror 模式克隆远端仓库，供后续反复复用。
   */
  async cloneMirror(repoUrl: string, targetDir: string): Promise<void> {
    // mirror clone 会把对象库完整缓存下来，后续 review 只需做 fetch + worktree，
    // 比每次重新 clone 一个普通仓库稳定得多，也更适合服务端长期运行。
    await this.run(['clone', '--mirror', repoUrl, targetDir]);
  }

  /**
   * 更新本地 git 目录里指定远端的 URL。
   */
  async setRemoteUrl(gitDir: string, remoteName: string, repoUrl: string): Promise<void> {
    await this.runForGitDir(gitDir, ['remote', 'set-url', remoteName, repoUrl]);
  }

  /**
   * 拉取 origin 的最新分支与标签信息，并清理已删除远端引用。
   */
  async fetchOrigin(gitDir: string): Promise<void> {
    await this.runForGitDir(gitDir, ['fetch', '--prune', '--tags', 'origin']);
  }

  /**
   * 显式拉取某个 ref，通常用于补抓指定提交。
   */
  async fetchRef(gitDir: string, remoteName: string, ref: string): Promise<void> {
    // 这里不做 ref 规范化，保留调用方传入的 sha / ref 原样，让 git 自己解析。
    await this.runForGitDir(gitDir, ['fetch', remoteName, ref]);
  }

  /**
   * 基于指定 ref 创建 detached worktree 供本次 review 使用。
   */
  async addDetachedWorktree(gitDir: string, worktreeDir: string, ref: string): Promise<void> {
    await this.runForGitDir(gitDir, ['worktree', 'add', '--detach', '--force', worktreeDir, ref]);
  }

  /**
   * 强制移除先前创建的 worktree 目录。
   */
  async removeWorktree(gitDir: string, worktreeDir: string): Promise<void> {
    await this.runForGitDir(gitDir, ['worktree', 'remove', '--force', worktreeDir]);
  }

  /**
   * 判断当前 git 目录里是否已经存在指定提交或引用。
   */
  async hasCommit(gitDir: string, ref: string): Promise<boolean> {
    try {
      await this.runForGitDir(gitDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
      return true;
    } catch (error: unknown) {
      this.rethrowIfGitMissing(error);
      // 这里故意把“提交不存在”视为普通 false，而不是异常；
      // 上层 checkout 逻辑会基于这个布尔值决定是否需要补 fetch 或回退到其它 ref。
      return false;
    }
  }

  /**
   * 判断给定目录是否是一个有效的 bare git 仓库。
   *
   * mirror 缓存目录可能因为中断或手动残留而只剩空目录，
   * checkout 层会用这个探针决定是否需要删掉并重建缓存。
   */
  async isBareRepository(gitDir: string): Promise<boolean> {
    try {
      const output = await this.runForGitDir(gitDir, ['rev-parse', '--is-bare-repository']);
      return output.trim() === 'true';
    } catch (error: unknown) {
      this.rethrowIfGitMissing(error);
      return false;
    }
  }

  /**
   * 在指定 git 目录上下文中执行 git 子命令。
   *
   * review 场景下大量使用 bare mirror，因此这里统一走 `--git-dir`，
   * 不要求当前目录本身是一个 worktree。
   */
  private async runForGitDir(gitDir: string, args: string[]): Promise<string> {
    return this.run(['--git-dir', gitDir, ...args]);
  }

  /**
   * 执行底层 git 命令，并统一注入禁用交互与认证参数。
   *
   * `GIT_TERMINAL_PROMPT=0` 可以避免 token 失效时卡在交互输入，
   * 让服务端直接拿到确定性失败。
   */
  private async run(args: string[]): Promise<string> {
    const authArgs = this.buildAuthArgs();

    try {
      const { stdout } = await execFileAsync('git', [...authArgs, ...args], {
        env: {
          ...process.env,
          // 服务端必须强制禁用交互 prompt，否则 token 失效时 git 会阻塞等待用户名/密码输入，
          // 整个 review 任务会表现成“卡死”，而不是立刻得到可诊断的失败。
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: 10 * 1024 * 1024,
      });

      return stdout.trim();
    } catch (error: unknown) {
      this.rethrowIfGitMissing(error);
      throw error;
    }
  }

  /**
   * 在存在 token 时构造 git HTTP 认证头参数。
   *
   * GitHub 与 GitLab 采用不同的 Basic 用户名占位，
   * 这里统一在客户端内部处理，上层无需关心。
   */
  private buildAuthArgs(): string[] {
    if (!this.options.token) {
      return [];
    }

    // GitHub 和 GitLab 都接受 Basic 认证头，但用户名占位不一样：
    // - GitHub 常用 x-access-token
    // - GitLab 常用 oauth2
    // 调用方只关心“这次走哪个平台”，不需要知道这些兼容细节。
    const username = this.options.scmType === 'github' ? 'x-access-token' : 'oauth2';
    const basicToken = Buffer.from(`${username}:${this.options.token}`, 'utf8').toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basicToken}`];
  }

  /**
   * 在底层错误是 `ENOENT` 时转成更明确的 git 缺失提示。
   *
   * 这样部署环境如果漏装 git，会直接抛出高可读错误，而不是系统底层异常。
   */
  private rethrowIfGitMissing(error: unknown): void {
    // 这里只拦截“git 根本不存在”这种环境问题；其余错误继续原样抛给上层，
    // 避免把认证失败、仓库不存在、网络错误等具体原因都吞掉。
    if (getErrorCode(error) === 'ENOENT') {
      throw new Error(GIT_NOT_FOUND_MESSAGE);
    }
  }
}
