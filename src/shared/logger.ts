/**
 * 定义服务内统一使用的日志器。
 *
 * 这个文件负责设置日志等级、时间戳、控制台输出格式，
 * 并导出全局复用的 Winston logger 实例。
 */
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

/**
 * 把 Winston 的标准日志字段格式化成便于终端阅读的单行文本。
 */
const myFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

/**
 * 服务全局日志实例，输出到控制台并遵循统一格式。
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize(),
    myFormat
  ),
  transports: [
    new winston.transports.Console()
  ],
});
