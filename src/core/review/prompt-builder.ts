/**
 * 负责组装发送给 LLM 的 review 提示词。
 *
 * 这个文件会把 PR 元数据、diff、静态信号、RAG 代码上下文和表结构
 * 压缩成一段受预算约束的提示词文本，并根据文件类型和 hunk 范围调整侧重点。
 */
import { CodeContext, FileDiff, PullRequestMetadata } from '../../types/index.js';
import { ReviewFileStrategy } from './file-review-strategy.js';

interface ContextBlock {
  label: string;
  body: string;
  preferredChars: number;
}

/**
 * 控制单次 review 提示词拼装方式的附加参数。
 */
export interface PromptBuildOptions {
  strategy: ReviewFileStrategy;
  segmentIndex?: number;
  totalSegments?: number;
}

/**
 * 负责把 diff、静态结果和 RAG 上下文组装成最终 review prompt。
 */
export class PromptBuilder {
  /**
   * 构建单文件或单段 hunk review 所需的完整提示词。
   */
  static build(
    pr: PullRequestMetadata,
    diff: FileDiff,
    context: CodeContext,
    options: PromptBuildOptions
  ): string {
    const segmentBudgetFactor = options.totalSegments && options.totalSegments > 1 ? 0.82 : 1;
    const signalContext = this.formatSignalContext(
      context,
      Math.max(260, Math.floor(options.strategy.signalBudget * segmentBudgetFactor))
    );
    const semanticSliceContext = this.formatSemanticSliceContext(
      context,
      Math.max(360, Math.floor(options.strategy.codeContextBudget * 0.42 * segmentBudgetFactor))
    );
    const codeContext = this.formatCodeContext(
      context,
      Math.max(520, Math.floor(options.strategy.codeContextBudget * 0.58 * segmentBudgetFactor))
    );
    const removedScopeContext = this.formatRemovedScopeContext(
      context,
      Math.max(260, Math.floor(options.strategy.signalBudget * 0.95 * segmentBudgetFactor))
    );
    const reviewScope = this.formatReviewScope(diff, options);
    const diffSection = this.formatDiffSection(diff);
    const fileChecklist = this.formatFileChecklist(options.strategy);

    return `
# 角色设定
你是一名拥有 10+ 年经验的资深工程师，负责做高信号代码评审。请重点识别会影响运行时行为、稳定性、安全性、并发一致性或发布安全的真实问题。

# 上下文信息
## 1. 评审对象
- 评审对象: ${pr.displayId}
- 标题: ${pr.title}
- 背景/描述: ${pr.description}

## 2. 当前文件与评审范围
${reviewScope}

## 3. 高置信度静态 / 变更影响信号
${signalContext}

## 4. 语义切片与结构化摘要
${semanticSliceContext}

## 5. 外部关联代码 (RAG Context)
${codeContext}

## 6. 被删除或削弱的旧逻辑
${removedScopeContext}

## 7. 待评审的变更
${diffSection}

# 文件类型专项关注
${fileChecklist}

# 通用审查底线
- 安全: 避免鉴权绕过、注入风险、XSS、敏感信息泄露、不安全配置放宽。
- 逻辑: 检查边界条件、异常处理、状态同步、资源释放、错误分支和回滚路径。
- 性能: 避免高频循环内耗时操作、无意义串行 await、低效查询、额外重渲染。
- 回归: 如果改动删除了旧逻辑、判断、过滤条件、事务或兜底分支，要优先判断是否会造成回归。

# 强制输出规则
1. 必须使用专业、简洁、温和的中文。
2. 只评论高价值问题，不要评论格式、排版、命名偏好或文档措辞。
3. "line" 必须是当前 diff 中新增侧可评论的行号。
4. 如果高置信度信号已经覆盖问题，不要机械重复；优先补充根因、影响范围或修复建议。
5. 如果当前只展示了文件的一段局部 hunk，请只针对当前展示的 diff 和提供的上下文评论，不要臆测未展示部分。
6. 如果提供“代码示例”，必须始终使用独立 fenced code block，即使只有一行代码，也不要写成行内反引号。

# 输出格式 (JSON ONLY)
你必须直接返回一个 JSON 对象，不包含任何开场白，也不要在 JSON 外层包裹 Markdown 代码块。
如果没有发现高价值问题，返回 {"comments": []}。
{
  "comments": [
    {
      "line": number,
      "body": "💡 **[分类]** 问题描述。\\n\\n建议: 具体改进方案。\\n\\n代码示例:\\n\\n\`\`\`ts\\nconst value = getValue();\\n\`\`\`",
      "side": "RIGHT"
    }
  ]
}
`.trim();
  }

  /**
   * 格式化当前 prompt 实际覆盖的评审范围说明。
   */
  private static formatReviewScope(diff: FileDiff, options: PromptBuildOptions): string {
    const chunkSummaries = diff.chunks
      .map((chunk, index) => `  - Hunk ${index + 1}: -${chunk.oldRange.start},${chunk.oldRange.lines} / +${chunk.newRange.start},${chunk.newRange.lines}`)
      .join('\n');
    const scopeLine = options.totalSegments && options.totalSegments > 1
      ? `- 当前范围: 这是该文件的第 ${options.segmentIndex}/${options.totalSegments} 个局部变更段`
      : '- 当前范围: 当前 prompt 覆盖该文件的全部可评审 diff';

    return [
      `- 文件路径: ${diff.path}`,
      `- 文件类型: ${options.strategy.label}`,
      scopeLine,
      `- Hunk 数量: ${diff.chunks.length}`,
      chunkSummaries,
    ].join('\n');
  }

  /**
   * 根据文件策略输出专项检查清单。
   */
  private static formatFileChecklist(strategy: ReviewFileStrategy): string {
    return strategy.focusAreas.map((item) => `- ${item}`).join('\n');
  }

  /**
   * 将 diff 片段按 hunk 可读地格式化出来。
   */
  private static formatDiffSection(diff: FileDiff): string {
    if (diff.chunks.length === 0) {
      return `文件路径: ${diff.path}\n（该文件没有可展示的 diff hunk）`;
    }

    const renderedChunks = diff.chunks.map((chunk, index) => {
      const chunkTitle = `### Hunk ${index + 1} (-${chunk.oldRange.start},${chunk.oldRange.lines} / +${chunk.newRange.start},${chunk.newRange.lines})`;
      return `${chunkTitle}\n\`\`\`diff\n${chunk.content.trimEnd()}\n\`\`\``;
    });

    return `文件路径: ${diff.path}\n\n${renderedChunks.join('\n\n')}`;
  }

  /**
   * 将静态分析和变更影响信号整理成紧凑的提示词片段。
   */
  private static formatSignalContext(context: CodeContext, budget: number): string {
    if (context.signals.length === 0) {
      return '（未发现可确认的高置信度信号）';
    }

    const seen = new Set<string>();
    const uniqueSignals = context.signals.filter((signal) => {
      const key = `${signal.source}:${signal.line ?? 0}:${signal.summary}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

    const rendered: string[] = [];
    let remainingChars = budget;

    for (const signal of uniqueSignals.slice(0, 8)) {
      const label = this.formatSignalLabel(signal.source, signal.line);
      const line = `- ${label} ${signal.summary}`;
      if (line.length > remainingChars && rendered.length > 0) {
        break;
      }

      rendered.push(line);
      remainingChars -= line.length;
    }

    if (uniqueSignals.length > rendered.length) {
      rendered.push(`- 其余 ${uniqueSignals.length - rendered.length} 条信号已省略。`);
    }

    return rendered.join('\n');
  }

  /**
   * 把函数和类型相关的外部代码上下文压缩成提示词片段。
   */
  private static formatCodeContext(context: CodeContext, budget: number): string {
    if (budget <= 0 || (context.functions.length === 0 && context.types.length === 0)) {
      return '（未发现外部关联代码）';
    }

    const blocks: ContextBlock[] = [
      ...this.deduplicateBySource(context.functions).map((item) => ({
        label: `【函数: ${item.name} | 来源: ${this.formatSourceLabel(item.file)}】`,
        body: item.content,
        preferredChars: 900,
      })),
      ...this.deduplicateBySource(context.types).map((item) => ({
        label: `【类型: ${item.name} | 来源: ${this.formatSourceLabel(item.file)}】`,
        body: item.content,
        preferredChars: 820,
      })),
    ];

    return this.packContextBlocks(
      blocks,
      budget,
      '（外部关联代码较多，已优先保留最相关定义）',
      'ts'
    );
  }

  /**
   * 把当前文件内的关键保护分支和同文件依赖切片整理成提示词片段。
   */
  private static formatSemanticSliceContext(context: CodeContext, budget: number): string {
    if (budget <= 0 || context.semanticSlices.length === 0) {
      return '（未提取到关键语义切片）';
    }

    const blocks: ContextBlock[] = context.semanticSlices.map((item) => ({
      label: `【${item.label} | 来源: ${this.formatSourceLabel(item.file)}】`,
      body: item.content,
      preferredChars: 720,
    }));

    return this.packContextBlocks(
      blocks,
      budget,
      '（语义切片较多，已优先保留最接近改动的片段）',
      'ts'
    );
  }

  /**
   * 把旧版本中被删除或被削弱的关键逻辑压缩成提示词片段。
   */
  private static formatRemovedScopeContext(context: CodeContext, budget: number): string {
    if (budget <= 0 || context.deletedScopes.length === 0) {
      return '（未检测到需要重点关注的删除型旧逻辑）';
    }

    const blocks: ContextBlock[] = context.deletedScopes.map((item) => ({
      label: `【旧逻辑: ${item.name || item.reason} | 来源: ${this.formatSourceLabel(item.file)}】`,
      body: `原因: ${item.reason}\n\n${item.content}`,
      preferredChars: 760,
    }));

    return this.packContextBlocks(
      blocks,
      budget,
      '（删除型旧逻辑较多，已优先保留最危险的片段）',
      'ts'
    );
  }

  /**
   * 在预算限制内拼装多个上下文块，并在必要时附加省略提示。
   */
  private static packContextBlocks(
    blocks: ContextBlock[],
    budget: number,
    truncatedHint: string,
    codeFence: string
  ): string {
    const renderedBlocks: string[] = [];
    let remainingBudget = budget;
    let omittedBlocks = 0;

    for (const block of blocks) {
      const blockBudget = Math.max(220, Math.min(block.preferredChars, remainingBudget - 120));
      if (blockBudget < 220) {
        omittedBlocks += 1;
        continue;
      }

      const renderedBlock = `${block.label}\n\`\`\`${codeFence}\n${this.compactCodeSnippet(block.body, blockBudget)}\n\`\`\``;
      if (renderedBlock.length > remainingBudget && renderedBlocks.length > 0) {
        omittedBlocks += 1;
        continue;
      }

      renderedBlocks.push(renderedBlock);
      remainingBudget -= renderedBlock.length + 2;
    }

    if (omittedBlocks > 0) {
      renderedBlocks.push(`${truncatedHint} 共省略 ${omittedBlocks} 段。`);
    }

    return renderedBlocks.join('\n\n');
  }

  /**
   * 对代码片段做轻量压缩，尽量保留结构信息并控制字符数。
   */
  private static compactCodeSnippet(content: string, maxChars: number): string {
    const normalized = content
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (normalized.length <= maxChars) {
      return normalized;
    }

    const lines = normalized.split('\n').map((line) => line.replace(/\s+$/g, ''));
    const excerpt: string[] = [];
    let usedChars = 0;

    for (const line of lines) {
      const nextLength = line.length + (excerpt.length > 0 ? 1 : 0);
      if (usedChars + nextLength > maxChars - 18) {
        break;
      }

      excerpt.push(line);
      usedChars += nextLength;

      if (excerpt.length >= 12 && line.includes('{')) {
        break;
      }
    }

    if (excerpt.length === 0) {
      return `${normalized.slice(0, maxChars - 18).trimEnd()}\n// ... truncated`;
    }

    return `${excerpt.join('\n')}\n// ... truncated`;
  }

  /**
   * 格式化上下文来源文件标签。
   */
  private static formatSourceLabel(filePath: string): string {
    return filePath === 'current' ? '当前文件' : filePath;
  }

  /**
   * 格式化静态分析信号来源标签。
   */
  private static formatSignalLabel(source: string, line?: number): string {
    const sourceLabel = source === 'dependency-cruiser'
      ? '[dependency-cruiser]'
      : source === 'eslint'
        ? '[eslint]'
        : source === 'diff-impact'
          ? '[change-impact]'
        : '[tsquery]';

    if (!line) {
      return sourceLabel;
    }

    return `${sourceLabel}[line ${line}]`;
  }

  /**
   * 基于名称和来源对上下文项做去重，避免提示词重复膨胀。
   */
  private static deduplicateBySource<T extends { name: string }>(items: T[]): T[] {
    const seenKeys = new Set<string>();
    return items.filter((item) => {
      const sourceKey = 'file' in item ? `${item.name}:${String(item.file)}` : item.name;
      if (seenKeys.has(sourceKey)) {
        return false;
      }

      seenKeys.add(sourceKey);
      return true;
    });
  }
}
