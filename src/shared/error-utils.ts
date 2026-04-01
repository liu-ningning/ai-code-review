/**
 * 提取未知异常对象里的稳定字段，统一日志和错误包装逻辑。
 */
interface ErrorShape {
  message?: unknown;
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/**
 * 尽可能从未知异常中提取可读错误信息。
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const message = getErrorField(error, 'message');
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  return String(error);
}

/**
 * 提取异常对象中的错误码字段。
 */
export function getErrorCode(error: unknown): string | undefined {
  const code = getErrorField(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

/**
 * 提取异常对象中的标准输出内容。
 */
export function getErrorStdout(error: unknown): string | undefined {
  const stdout = getErrorField(error, 'stdout');
  return typeof stdout === 'string' ? stdout : undefined;
}

/**
 * 提取异常对象中的标准错误输出内容。
 */
export function getErrorStderr(error: unknown): string | undefined {
  const stderr = getErrorField(error, 'stderr');
  return typeof stderr === 'string' ? stderr : undefined;
}

function getErrorField(error: unknown, field: keyof ErrorShape): unknown {
  return isErrorShape(error) ? error[field] : undefined;
}

function isErrorShape(error: unknown): error is ErrorShape {
  return typeof error === 'object' && error !== null;
}
