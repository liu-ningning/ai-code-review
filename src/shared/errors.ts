/**
 * 定义服务内部通用错误类型。
 *
 * 这个文件负责约束业务异常的分类编码，并提供统一的应用层错误基类，
 * 方便配置、Provider、LLM 等模块抛出结构化异常。
 */
/**
 * 约束服务内部可观测的错误分类编码。
 */
export enum ErrorCode {
  CONFIG_ERROR = 'CONFIG_ERROR',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  LLM_ERROR = 'LLM_ERROR',
  RAG_ERROR = 'RAG_ERROR',
  CORE_ERROR = 'CORE_ERROR',
}

/**
 * 服务内部所有结构化异常的统一基类。
 */
export class AppError extends Error {
  /**
   * 创建一个带错误分类和原始异常的应用层错误对象。
   */
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * 表示配置读取、校验或缺失导致的异常。
 */
export class ConfigError extends AppError {
  /**
   * 创建配置校验或配置缺失时使用的错误对象。
   */
  constructor(message: string) {
    super(ErrorCode.CONFIG_ERROR, message);
  }
}

/**
 * 表示外部 Provider 或基础设施调用失败的异常。
 */
export class ProviderError extends AppError {
  /**
   * 创建外部 Provider 调用失败时使用的错误对象。
   */
  constructor(message: string, originalError?: unknown) {
    super(ErrorCode.PROVIDER_ERROR, message, originalError);
  }
}

/**
 * 表示模型调用或模型输出解析失败的异常。
 */
export class LLMError extends AppError {
  /**
   * 创建 LLM 调用或模型响应解析失败时使用的错误对象。
   */
  constructor(message: string, originalError?: unknown) {
    super(ErrorCode.LLM_ERROR, message, originalError);
  }
}
