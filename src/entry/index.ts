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
import { ISCMProvider } from '../types/index.js';

const fastify = Fastify({ logger: false });

/**
 * 根据当前配置创建 SCM provider，供 pipeline 和控制器按需调用。
 */
function createScmProvider(): ISCMProvider {
  if (config.SCM_TYPE === 'github') {
    if (!config.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not configured');
    }

    return new GitHubProvider({
      token: config.GITHUB_TOKEN,
      apiBaseUrl: config.GITHUB_API_BASE_URL,
      webBaseUrl: config.GITHUB_WEB_BASE_URL,
    });
  }

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
 */
const reviewCoordinator = new ReviewCoordinator({
  executor: async ({ owner, repo, prNumber }) => {
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
 */
async function assertRuntimeDependencies(): Promise<void> {
  await new GitClient().assertAvailable();
}

registerReviewController(fastify, {
  createScmProvider,
  reviewCoordinator,
});

/**
 * 启动 HTTP 服务，并在失败时记录错误后终止进程。
 */
const start = async () => {
  try {
    await assertRuntimeDependencies();
    await reviewCoordinator.initialize();

    const port = Number(process.env.PORT) || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });

    if (config.SCM_TYPE === 'github' && !config.GITHUB_TOKEN) {
      logger.warn('GITHUB_TOKEN is not configured. CI review endpoints will reject GitHub review requests.');
    }

    if (config.SCM_TYPE === 'gitlab' && !config.GITLAB_TOKEN) {
      logger.warn('GITLAB_TOKEN is not configured. Webhook and CI review endpoints will reject requests.');
    }

    logger.info(`SCM mode: ${config.SCM_TYPE}`);
    logger.info(`AI Review Server is running at http://localhost:${port}`);
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

start();
