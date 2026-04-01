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
      return false;
    }
  }

  /**
   * 在指定 git 目录上下文中执行 git 子命令。
   */
  private async runForGitDir(gitDir: string, args: string[]): Promise<string> {
    return this.run(['--git-dir', gitDir, ...args]);
  }

  /**
   * 执行底层 git 命令，并统一注入禁用交互与认证参数。
   */
  private async run(args: string[]): Promise<string> {
    const authArgs = this.buildAuthArgs();

    try {
      const { stdout } = await execFileAsync('git', [...authArgs, ...args], {
        env: {
          ...process.env,
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
   */
  private buildAuthArgs(): string[] {
    if (!this.options.token) {
      return [];
    }

    const username = this.options.scmType === 'github' ? 'x-access-token' : 'oauth2';
    const basicToken = Buffer.from(`${username}:${this.options.token}`, 'utf8').toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basicToken}`];
  }

  /**
   * 在底层错误是 `ENOENT` 时转成更明确的 git 缺失提示。
   */
  private rethrowIfGitMissing(error: unknown): void {
    if (getErrorCode(error) === 'ENOENT') {
      throw new Error(GIT_NOT_FOUND_MESSAGE);
    }
  }
}
