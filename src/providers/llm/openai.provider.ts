/**
 * 封装 review 服务对 OpenAI 兼容接口的调用。
 *
 * 这个文件负责发送单文件 review 提示词、解析模型返回的 JSON，
 * 并把结果转换成内部统一使用的评论结构。
 */
import OpenAI from 'openai';
import { z } from 'zod';
import { getErrorMessage } from '../../shared/error-utils.js';
import { logger } from '../../shared/logger.js';
import { LLMError } from '../../shared/errors.js';
import { ReviewComment } from '../../types/index.js';

/**
 * 定义单条 review 评论在模型响应中的合法结构。
 */
const reviewCommentSchema = z.object({
  line: z.coerce.number().int().positive(),
  body: z.string().trim().min(1),
  side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
});

/**
 * 兼容 `{ comments: [] }` 和数组两种模型输出形态。
 */
const reviewPayloadSchema = z.union([
  z.object({
    comments: z.array(reviewCommentSchema).default([]),
  }),
  z.array(reviewCommentSchema),
]).transform((payload) => Array.isArray(payload) ? payload : payload.comments);

interface OpenAIProviderOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

/**
 * 调用 LLM 生成代码评审评论，并负责解析和校验响应内容。
 */
export class OpenAIProvider {
  private client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  /**
   * 创建 LLM provider，并绑定模型、鉴权与服务地址。
   */
  constructor(apiKey: string, model: string, baseUrl: string, options: OpenAIProviderOptions = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 1_000);
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl.replace(/\/$/, ''),
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
    this.model = model;
  }

  /**
   * 发送提示词给模型，并把响应解析成当前文件的 review 评论。
   *
   * provider 自己负责处理瞬时失败重试，因此 pipeline 层只需要把它当作
   * “单文件生成评论”的原子操作调用，不需要再额外包一层重试。
   */
  async generateReview(prompt: string, filePath: string): Promise<ReviewComment[]> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) {
          logger.error('LLM response was empty for review generation', {
            filePath,
            model: this.model,
            finishReason: response.choices[0]?.finish_reason,
          });
          throw new LLMError(`LLM returned an empty review payload for ${filePath}`);
        }

        const usageLine = this.buildUsageLine(response.usage);
        if (response.usage) {
          logger.info('LLM usage recorded for review generation', {
            filePath,
            model: this.model,
            promptTokens: response.usage.prompt_tokens ?? 0,
            completionTokens: response.usage.completion_tokens ?? 0,
            totalTokens: response.usage.total_tokens ?? 0,
          });
        }

        return this.parseResponse(content, filePath, usageLine);
      } catch (error: unknown) {
        if (error instanceof LLMError) {
          throw error;
        }

        const retryable = this.isRetryableSdkError(error);
        const hasRetryBudget = attempt < this.maxRetries;
        const errorMessage = getErrorMessage(error);

        if (retryable && hasRetryBudget) {
          const delayMs = this.getRetryDelayMs(error, attempt);
          logger.warn('LLM request failed with a retryable error; retrying review generation', {
            filePath,
            model: this.model,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delayMs,
            error: errorMessage,
          });
          await this.sleep(delayMs);
          continue;
        }

        logger.error('OpenAI SDK calling failed', {
          error: errorMessage,
          filePath,
          model: this.model,
          attempt: attempt + 1,
          retryable,
        });
        throw new LLMError(`OpenAI SDK Error: ${errorMessage}`);
      }
    }

    throw new LLMError(`OpenAI SDK Error: review generation exhausted retry budget for ${filePath}`);
  }

  /**
   * 校验模型返回的 JSON 结构，并规范化为内部评论对象。
   *
   * 这里除了做 schema 校验，还会顺手去重和统一正文格式，避免模型重复输出
   * 相同行号/相同内容的评论，或输出难以在 SCM 页面稳定渲染的自由文本代码示例。
   */
  private parseResponse(content: string, filePath: string, usageLine: string | null): ReviewComment[] {
    try {
      const rawPayload = this.parseJsonPayload(content);
      const parsedPayload = reviewPayloadSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        logger.error('Failed to validate LLM response schema', {
          issues: parsedPayload.error.issues,
          content,
        });
        throw new LLMError(
          `LLM returned an invalid review schema for ${filePath}`,
          parsedPayload.error
        );
      }

      const seenComments = new Set<string>();
      const normalizedComments: ReviewComment[] = [];

      for (const comment of parsedPayload.data) {
        const key = `${comment.line}:${comment.body}`;
        if (seenComments.has(key)) {
          continue;
        }

        seenComments.add(key);
        const normalizedBody = this.normalizeCommentBody(comment.body, filePath);
        normalizedComments.push({
          path: filePath,
          line: comment.line,
          body: this.prependUsageLine(normalizedBody, usageLine),
          side: comment.side,
        });
      }

      return normalizedComments;
    } catch (error: unknown) {
      if (error instanceof LLMError) {
        throw error;
      }
      logger.error('Failed to parse LLM response as JSON', { content });
      throw new LLMError(`LLM returned invalid JSON for ${filePath}`, error);
    }
  }

  /**
   * 判断 SDK 错误是否值得重试，主要覆盖限流、超时和瞬时网络失败。
   */
  private isRetryableSdkError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as {
      status?: number;
      code?: string;
      name?: string;
      message?: string;
    };
    const status = typeof candidate.status === 'number' ? candidate.status : undefined;
    if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
      return true;
    }

    const code = String(candidate.code ?? '').toUpperCase();
    if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
      return true;
    }

    const name = String(candidate.name ?? '').toLowerCase();
    if (name.includes('timeout') || name.includes('rate') || name.includes('connection')) {
      return true;
    }

    const message = getErrorMessage(error).toLowerCase();
    return message.includes('timeout')
      || message.includes('timed out')
      || message.includes('rate limit')
      || message.includes('too many requests');
  }

  /**
   * 基于 retry-after 或指数退避计算下一次重试等待时长。
   *
   * 如果上游显式给了 `retry-after`，优先尊重服务端节流窗口；否则退回
   * 到本地的指数退避策略，减少短时间内连续打满配额。
   */
  private getRetryDelayMs(error: unknown, attempt: number): number {
    const retryAfterMs = this.getRetryAfterMs(error);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }

    return this.retryBaseDelayMs * (2 ** attempt);
  }

  /**
   * 尝试从 SDK 错误对象里解析 `retry-after`，兼容浏览器 Headers 和普通对象。
   */
  private getRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const headersCandidate = (error as {
      headers?: Record<string, unknown> | Headers;
    }).headers;
    if (!headersCandidate) {
      return null;
    }

    let retryAfterValue: string | null = null;
    if (typeof Headers !== 'undefined' && headersCandidate instanceof Headers) {
      retryAfterValue = headersCandidate.get('retry-after');
    } else {
      const headerRecord = headersCandidate as Record<string, unknown>;
      const rawValue = headerRecord['retry-after'] ?? headerRecord['Retry-After'];
      retryAfterValue = typeof rawValue === 'string'
        ? rawValue
        : typeof rawValue === 'number'
          ? String(rawValue)
          : null;
    }

    if (!retryAfterValue) {
      return null;
    }

    const seconds = Number(retryAfterValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    const retryAt = Date.parse(retryAfterValue);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }

    return null;
  }

  /**
   * 轻量 sleep 封装，只用于重试退避，避免把 `setTimeout` 细节散落在主流程里。
   */
  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 从模型文本响应中尽可能提取出一段可解析的 JSON payload。
   *
   * 实际模型输出并不总是严格只返回 JSON：
   * 1. 有时会包在 fenced code block 里
   * 2. 有时会在 JSON 前后夹带解释性文本
   * 3. 有时会错误地连续输出多个顶层对象
   *
   * 这里按“最严格到最宽松”的顺序逐级兜底，尽量把可恢复的输出救回来，
   * 但最终仍把结构合法性交给 zod schema 校验。
   */
  private parseJsonPayload(content: string): unknown {
    const normalized = content.trim();
    const directPayload = this.tryParseJson(normalized);
    if (directPayload !== null) {
      return directPayload;
    }

    const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch) {
      const fencedPayload = this.tryParseJson(fencedMatch[1].trim());
      if (fencedPayload !== null) {
        return fencedPayload;
      }
    }

    const objectStart = normalized.indexOf('{');
    const objectEnd = normalized.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
      const objectPayload = this.tryParseJson(normalized.slice(objectStart, objectEnd + 1));
      if (objectPayload !== null) {
        return objectPayload;
      }
    }

    const arrayStart = normalized.indexOf('[');
    const arrayEnd = normalized.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      const arrayPayload = this.tryParseJson(normalized.slice(arrayStart, arrayEnd + 1));
      if (arrayPayload !== null) {
        return arrayPayload;
      }
    }

    const objectSequencePayload = this.tryParseObjectSequence(normalized);
    if (objectSequencePayload !== null) {
      return objectSequencePayload;
    }

    throw new Error('No valid JSON payload found in LLM response');
  }

  /**
   * 尝试直接把一段文本解析为 JSON，对失败场景返回 null。
   */
  private tryParseJson(content: string): unknown | null {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * 尝试把多个顶层对象拼成的响应解析成对象数组。
   *
   * 这是兜底分支，主要应对模型输出 `{...}{...}` 这类并非标准 JSON、
   * 但每个对象本身都合法的情况。
   */
  private tryParseObjectSequence(content: string): unknown[] | null {
    const objectSlices = this.extractTopLevelObjects(content);
    if (objectSlices.length === 0) {
      return null;
    }

    const parsedObjects: unknown[] = [];
    for (const objectSlice of objectSlices) {
      const parsedObject = this.tryParseJson(objectSlice);
      if (parsedObject === null) {
        return null;
      }

      parsedObjects.push(parsedObject);
    }

    return parsedObjects;
  }

  /**
   * 从文本中扫描并提取所有顶层 JSON 对象片段。
   *
   * 这里需要显式处理字符串和转义状态，否则正文里的花括号会被误识别成
   * 结构边界，导致对象切片不完整。
   */
  private extractTopLevelObjects(content: string): string[] {
    const slices: string[] = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < content.length; index++) {
      const char = content[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          startIndex = index;
        }
        depth++;
        continue;
      }

      if (char === '}') {
        if (depth === 0 || startIndex === -1) {
          continue;
        }

        depth--;
        if (depth === 0) {
          slices.push(content.slice(startIndex, index + 1));
          startIndex = -1;
        }
      }
    }

    return slices;
  }

  /**
   * 把 token 使用情况格式化成可附加到评论正文前的说明行。
   *
   * 这不是业务必需字段，但在排查成本、prompt 膨胀和模型行为异常时很有用，
   * 因此以纯文本方式附着到评论上，方便直接在 SCM 页面看到。
   */
  private buildUsageLine(
    usage?: {
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      total_tokens?: number | null;
    } | null
  ): string | null {
    if (!usage) {
      return null;
    }

    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
      return null;
    }

    return `Token 消耗: 输入 ${promptTokens} / 输出 ${completionTokens} / 总计 ${totalTokens}`;
  }

  /**
   * 在评论正文前附加 token 使用信息，便于调试和成本观察。
   */
  private prependUsageLine(body: string, usageLine: string | null): string {
    if (!usageLine) {
      return body;
    }

    return `${usageLine}\n\n${body}`;
  }

  /**
   * 统一规范评论正文中的“代码示例”区域，避免有时是代码块、有时是普通文本。
   *
   * provider 在最终出口做这层清洗，可以保证不论 prompt 如何变化，
   * 发到 GitHub/GitLab 的评论都尽量保持稳定的渲染效果。
   */
  private normalizeCommentBody(body: string, filePath: string): string {
    const normalized = body.replace(/\r\n/g, '\n').trim();
    return this.normalizeCodeExampleSection(normalized, filePath);
  }

  /**
   * 把“代码示例”统一转成 fenced code block，GitLab 渲染会更稳定。
   *
   * 这里约定只处理明确以“代码示例”收尾的段落，避免误伤正文里的普通解释文本。
   */
  private normalizeCodeExampleSection(body: string, filePath: string): string {
    const markerMatch = body.match(/代码示例[:：]\s*([\s\S]*)$/);
    if (!markerMatch) {
      return body;
    }

    const markerStart = markerMatch.index ?? -1;
    if (markerStart < 0) {
      return body;
    }

    const before = body.slice(0, markerStart).trimEnd();
    const rawExample = markerMatch[1].trim();
    if (!rawExample) {
      return body;
    }

    if (/^```/.test(rawExample)) {
      return `${before}\n\n代码示例:\n\n${this.ensureCodeFenceLanguage(rawExample, filePath)}`.trim();
    }

    const inlineCodeMatch = rawExample.match(/^`([^`]+)`$/);
    const codeContent = inlineCodeMatch ? inlineCodeMatch[1].trim() : rawExample;
    if (!this.looksLikeCodeSnippet(codeContent)) {
      return body;
    }

    const codeFenceLanguage = this.inferCodeFenceLanguage(filePath, codeContent);
    return `${before}\n\n代码示例:\n\n\`\`\`${codeFenceLanguage}\n${codeContent}\n\`\`\``.trim();
  }

  /**
   * 如果模型已经给了代码块但没标语言，则按当前文件补一个合理的 fence language。
   */
  private ensureCodeFenceLanguage(fencedBlock: string, filePath: string): string {
    const blockMatch = fencedBlock.match(/^```([^\n`]*)\n([\s\S]*?)```$/);
    if (!blockMatch) {
      return fencedBlock;
    }

    const currentLanguage = blockMatch[1].trim();
    if (currentLanguage) {
      return fencedBlock;
    }

    const code = blockMatch[2].replace(/\n$/, '');
    return `\`\`\`${this.inferCodeFenceLanguage(filePath, code)}\n${code}\n\`\`\``;
  }

  /**
   * 轻量判断一段文本是否像代码，避免把普通说明误包成代码块。
   */
  private looksLikeCodeSnippet(content: string): boolean {
    const normalized = content.trim();
    if (!normalized) {
      return false;
    }

    if (normalized.includes('\n')) {
      return /[{}();=>]|^\s*(const|let|var|function|if|return|await|fetch|SELECT|UPDATE|DELETE|INSERT|FROM|RUN|CMD)\b/m.test(normalized);
    }

    return /[();=>{}]|\b(const|let|var|return|await|fetch|SELECT|UPDATE|DELETE|INSERT|FROM|set[A-Z]\w*|use[A-Z]\w*)\b/.test(normalized);
  }

  /**
   * 根据当前 review 文件路径推断最适合的代码块语言。
   *
   * 这是一个偏启发式的映射，目标不是绝对准确，而是尽量让 SCM 页面上的
   * 代码高亮更接近真实语言，提升 review 可读性。
   */
  private inferCodeFenceLanguage(filePath: string, content: string): string {
    if (/^\s*(RUN|CMD|ENTRYPOINT|FROM|COPY|ADD)\b/m.test(content)) {
      return 'bash';
    }

    if (/\.tsx$/i.test(filePath)) {
      return 'tsx';
    }

    if (/\.ts$/i.test(filePath)) {
      return 'ts';
    }

    if (/\.jsx$/i.test(filePath)) {
      return 'jsx';
    }

    if (/\.js$/i.test(filePath)) {
      return 'js';
    }

    if (/\.ya?ml$/i.test(filePath)) {
      return 'yaml';
    }

    if (/\.jsonc?$/i.test(filePath)) {
      return 'json';
    }

    return 'ts';
  }
}
