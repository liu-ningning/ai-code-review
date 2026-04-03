/**
 * 负责加载并校验服务运行所需的环境配置。
 *
 * 这个文件会在进程启动时读取 `.env` 和系统环境变量，
 * 使用 Zod 做结构化校验，并导出全局可复用的配置对象。
 */
import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigError } from '../shared/errors.js';

dotenv.config();

/**
 * 定义当前服务支持的所有环境变量及其默认值。
 */
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // SCM
  SCM_TYPE: z.enum(['gitlab', 'github']).default('gitlab'),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_BASE_URL: z.string().default('https://gitlab.com'),
  GITLAB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().default('https://api.github.com'),
  GITHUB_WEB_BASE_URL: z.string().default('https://github.com'),
  CI_REVIEW_TOKEN: z.string().optional(),

  // LLM
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('mimo-v2-flash'),
  LLM_BASE_URL: z.string().default('https://api.xiaomimimo.com/v1'),
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().default(2),
  LLM_RETRY_BASE_DELAY_MS: z.coerce.number().default(1000),
  REVIEW_AGENT_PROFILES: z.string().default('correctness,security,regression'),

  // RAG & Budget
  MAX_FILE_TOKEN_BUDGET: z.coerce.number().default(4000),
  MAX_RAG_HOPS: z.coerce.number().default(1),
  REVIEW_FILE_CONCURRENCY: z.coerce.number().default(2),
  LLM_REVIEW_CONCURRENCY: z.coerce.number().default(2),
  REVIEW_FAIL_ON_COMMENTS: z.coerce.boolean().default(true),
});

/**
 * 基于配置 Schema 推导出的运行时配置类型。
 */
export type Config = z.infer<typeof configSchema>;

/**
 * 从进程环境中加载配置，并在校验失败时抛出统一配置异常。
 */
export const loadConfig = (): Config => {
  try {
    return configSchema.parse(process.env);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:', error.format());
      throw new ConfigError(`Invalid configuration: ${JSON.stringify(error.format())}`);
    }
    throw error;
  }
};

/**
 * 当前进程的全局配置实例，供各模块直接读取。
 */
export const config = loadConfig();
