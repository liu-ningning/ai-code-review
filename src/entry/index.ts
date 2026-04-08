/**
 * 服务进程启动入口。
 *
 * 这个文件负责初始化 Fastify、创建核心依赖、注册路由控制器，
 * 并在启动阶段检查运行时依赖和调度器状态。
 */
import Fastify from 'fastify';
import { config } from '../config/index.js';
import { registerReviewController } from '../controllers/review.controller.js';
import { ReviewCoordinator } from '../core/pipeline/review-coordinator.js';
import { ReviewPipeline } from '../core/pipeline/review-pipeline.js';
import { GitClient } from '../core/review/git-client.js';
import { GitHubProvider } from '../providers/scm/github.provider.js';
import { GitLabProvider } from '../providers/scm/gitlab.provider.js';
import { logger } from '../shared/logger.js';
import { ISCMProvider, SCMType } from '../types/index.js';

/**
 * 当前进程唯一的 Fastify 实例。
 *
 * 这里关闭了 Fastify 自带 logger，统一使用项目自己的 winston logger，
 * 避免输出格式和日志级别体系分裂。
 */
const fastify = Fastify({ logger: false });

/**
 * 根据当前配置创建 SCM provider，供 pipeline 和控制器按需调用。
 *
 * 入口层不直接把某个 provider 做成全局单例，而是提供一个工厂函数，
 * 这样控制器、pipeline、测试和未来的旁路任务都可以按需创建自己的实例。
 */
function createScmProvider(scmType: SCMType = config.SCM_TYPE): ISCMProvider {
  // GitHub 模式下创建 GitHubProvider，并注入 API / Web 根地址。
  if (scmType === 'github') {
    if (!config.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not configured');
    }

    return new GitHubProvider({
      token: config.GITHUB_TOKEN,
      apiBaseUrl: config.GITHUB_API_BASE_URL,
      webBaseUrl: config.GITHUB_WEB_BASE_URL,
    });
  }

  // 否则默认走 GitLab / JiHuLab 兼容 provider。
  if (!config.GITLAB_TOKEN) {
    throw new Error('GITLAB_TOKEN is not configured');
  }

  return new GitLabProvider({
    token: config.GITLAB_TOKEN,
    baseUrl: config.GITLAB_BASE_URL,
  });
}

/**
 * 统一调度 Merge Request review，避免入口层直接编排 pipeline 细节。
 *
 * webhook 场景下只需要告诉 coordinator：
 * - 哪个仓库
 * - 哪个 MR
 * - 最新 headSha 是什么
 *
 * 真正的 review 编排仍然发生在 ReviewPipeline 内部。
 */
const reviewCoordinator = new ReviewCoordinator({
  executor: async ({ owner, repo, prNumber }) => {
    // 每次执行都重新创建 pipeline，避免把一次运行态状态泄漏给下一次任务。
    const pipeline = new ReviewPipeline(createScmProvider());
    await pipeline.run({
      kind: 'merge_request',
      owner,
      repo,
      number: prNumber,
    });
  },
});

/**
 * 在服务启动前检查运行环境中必须存在的外部依赖。
 *
 * 目前最关键的是 git：
 * 没有 git，仓库 mirror / fetch / worktree 整条链都无法运行。
 */
async function assertRuntimeDependencies(): Promise<void> {
  await new GitClient().assertAvailable();
}

/**
 * 注册 review 相关路由。
 *
 * 控制器只依赖两个入口层注入物：
 * - provider 工厂：按当前 SCM 模式创建访问器
 * - coordinator：负责 webhook / CI 的串行调度
 */
registerReviewController(fastify, {
  createScmProvider,
  reviewCoordinator,
});

/**
 * 启动 HTTP 服务，并在失败时记录错误后终止进程。
 *
 * 启动顺序固定为：
 * 1. 校验运行时依赖
 * 2. 初始化 coordinator
 * 3. 监听 HTTP 端口
 * 4. 输出关键运行信息
 */
const start = async () => {
  try {
    await assertRuntimeDependencies();
    await reviewCoordinator.initialize();

    // `PORT` 允许外部注入；未配置时默认监听 9527
    const port = Number(process.env.PORT) || 9527;
    await fastify.listen({ port, host: '0.0.0.0' });

    // 这里的告警更多是“运行后一定会拒绝请求”的早期提醒，
    // 便于在启动日志里直接发现配置缺失。
    if (config.SCM_TYPE === 'github' && !config.GITHUB_TOKEN) {
      logger.warn('⚠️ GITHUB_TOKEN is not configured. CI review endpoints will reject GitHub review requests.');
    }

    if (config.SCM_TYPE === 'gitlab' && !config.GITLAB_TOKEN) {
      logger.warn('⚠️ GITLAB_TOKEN is not configured. Webhook and CI review endpoints will reject requests.');
    }

    logger.info(`SCM mode: ${config.SCM_TYPE}`);
    logger.info(`AI Review Server is running at http://127.0.0.1:${port}`);
  } catch (err) {
    // 启动失败时直接退出进程，让容器编排或进程管理器接管重启/告警。
    logger.error('❌ Failed to start server', err);
    process.exit(1);
  }
};

/**
 * 立即启动服务进程。
 */
start();
