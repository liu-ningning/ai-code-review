/**
 * 负责为单文件 review 组装外部上下文。
 *
 * 当前版本只保留代码符号、结构化摘要和删除型旧逻辑，不再包含外部存储
 * 相关增强。
 */
import { LRUCache } from 'lru-cache';
import { CodeContext, FileDiff, ISCMProvider, ReviewSignal } from '../types/index.js';
import { CodeAnalyzer, ExtractedSymbol, IdentifierCandidate } from './extractor/code-analyzer.js';
import { StructuredFileAnalyzer } from './extractor/structured-file-analyzer.js';
import { config } from '../config/index.js';
import { logger } from '../shared/logger.js';
import type { ReviewFileRagStrategy, ReviewFileStrategy } from '../core/review/file-review-strategy.js';
import { splitDiffIntoReviewSegments } from '../core/review/diff-utils.js';

interface RagExtractionOptions {
  targetRef: string;
  baselineRef?: string;
  initialSignals?: ReviewSignal[];
  strategy?: ReviewFileStrategy;
}

interface ResolvedSymbolContext {
  path: string;
  symbols: ExtractedSymbol[];
}

export class RAGEngine {
  // 默认 profile 偏保守，目标是给 prompt 补“高信号、低噪音”的上下文，
  // 而不是把整份仓库切片都塞进模型。
  private static readonly DEFAULT_RAG_PROFILE: ReviewFileRagStrategy = {
    allowCodeContext: true,
    allowRemoteSymbolSearch: true,
    maxRemoteSymbolLookups: 3,
    maxSearchResultsPerLookup: 5,
    allowTableLookup: false,
    maxTableLookups: 0,
    maxFunctionContexts: 2,
    maxTypeContexts: 2,
    maxSemanticSlices: 2,
    maxDeletedScopeContexts: 2,
  };

  private codeAnalyzer = new CodeAnalyzer();
  private structuredFileAnalyzer = new StructuredFileAnalyzer();
  // 三层缓存分别覆盖“远程符号解析结果”“文件内容”“代码搜索结果”，
  // 减少单次 review 中同一 ref/同一符号被重复拉取。
  private symbolCache = new LRUCache<string, Promise<ResolvedSymbolContext | null>>({ max: 256 });
  private fileContentCache = new LRUCache<string, Promise<string>>({ max: 256 });
  private searchCache = new LRUCache<string, Promise<string[]>>({ max: 128 });

  constructor(
    private scmProvider: ISCMProvider,
    private repositoryRoot?: string
  ) {}

  /**
   * 清空当前 provider 实例上的缓存。
   *
   * 一次 review 过程中缓存可以显著减少远程 I/O；但跨仓库或跨 ref 复用实例时，
   * 主动清空可以避免把旧上下文带入新的 review 目标。
   */
  clearCache(): void {
    this.symbolCache.clear();
    this.fileContentCache.clear();
    this.searchCache.clear();
  }

  async segmentDiff(
    owner: string,
    repo: string,
    diff: FileDiff,
    targetRef: string,
    maxSegments = 4
  ): Promise<FileDiff[]> {
    // 默认先按行距切段，确保即使语义分段失败也不会阻断 review。
    const fallbackSegments = splitDiffIntoReviewSegments(diff, { maxGapLines: 24, maxSegments });
    if (diff.chunks.length <= 1) {
      return fallbackSegments;
    }

    // 只有拿到目标版本的完整文件内容，才有机会按函数/类等语义边界重新切段。
    const currentFileContent = await this.getFileContent(owner, repo, diff.path, targetRef);
    if (!currentFileContent) {
      return fallbackSegments;
    }

    return this.codeAnalyzer.segmentDiffBySemanticScope(diff.path, currentFileContent, diff, {
      maxGapLines: 24,
      maxSegments,
    });
  }

  async extract(
    owner: string,
    repo: string,
    diff: FileDiff,
    options: RagExtractionOptions
  ): Promise<CodeContext> {
    // 所有上下文都汇总到统一的 `CodeContext`，后续 prompt builder 不需要关心
    // 上下文来自当前文件、远程符号还是删除的旧逻辑。
    const initialSignals = options.initialSignals ?? [];
    const ragProfile = this.getRagProfile(diff, initialSignals, options.strategy);
    const context: CodeContext = {
      functions: [],
      types: [],
      semanticSlices: [],
      deletedScopes: [],
      signals: [...initialSignals],
    };

    const diffContent = diff.chunks.map((chunk) => chunk.content).join('\n');
    const currentFileContent = await this.getFileContent(owner, repo, diff.path, options.targetRef);

    if (currentFileContent) {
      // 对 YAML/JSON/Shell 等结构化文件，先抽一层轻量摘要，帮助模型知道“改的是哪块配置”。
      this.distributeSemanticSlices(
        this.structuredFileAnalyzer.analyze(diff.path, currentFileContent, diff),
        context,
        ragProfile
      );
    }

    if (!ragProfile.allowCodeContext) {
      return context;
    }

    // 代码语义分析是主要分支。失败时也会退回到基于 diff 文本的启发式标识符提取。
    const diffAnalysis = currentFileContent
      ? await this.codeAnalyzer.analyzeFileDiff(diff.path, currentFileContent, diff)
      : { identifiers: CodeAnalyzer.getPotentialIdentifiers(diffContent), localSymbols: [], semanticSlices: [] };
    const identifierCandidates = diffAnalysis.identifiers;

    if (diffAnalysis.localSymbols.length > 0) {
      // 本文件内能直接解析到的符号优先级最高，成本最低，也最贴近当前变更。
      this.distributeSymbols(diffAnalysis.localSymbols, context, 'current', ragProfile);
    }

    if (diffAnalysis.semanticSlices.length > 0) {
      this.distributeSemanticSlices(diffAnalysis.semanticSlices, context, ragProfile);
    }

    if (currentFileContent && identifierCandidates.length > 0) {
      // 对候选标识符再做一次同文件精确提取，弥补 scope-based 提取遗漏的定义。
      const symbols = await this.codeAnalyzer.extractSymbol(
        diff.path,
        currentFileContent,
        identifierCandidates.map((candidate) => candidate.name)
      );
      this.distributeSymbols(symbols, context, 'current', ragProfile);
    }

    if (ragProfile.allowRemoteSymbolSearch && config.MAX_RAG_HOPS > 0) {
      // 仅对当前上下文里还没解析到的标识符做远程搜索，控制 hop 数和预算，
      // 避免 RAG 阶段退化成“全仓库符号追踪器”。
      const resolvedSymbols = new Set([
        ...context.functions.map((symbol) => symbol.name),
        ...context.types.map((symbol) => symbol.name),
      ]);

      const missingCandidates = identifierCandidates.filter((candidate) => !resolvedSymbols.has(candidate.name));
      for (const candidate of missingCandidates.slice(0, ragProfile.maxRemoteSymbolLookups)) {
        const resolvedContext = await this.resolveSymbolContext(
          owner,
          repo,
          diff.path,
          candidate,
          options.targetRef,
          ragProfile
        );
        if (!resolvedContext || resolvedContext.path === diff.path) {
          continue;
        }

        this.distributeSymbols(resolvedContext.symbols, context, resolvedContext.path, ragProfile);
        for (const symbol of resolvedContext.symbols) {
          resolvedSymbols.add(symbol.name);
        }
      }
    }

    if (options.baselineRef && ragProfile.maxDeletedScopeContexts > 0 && diff.status !== 'added') {
      // 删除型上下文只在有 baseline ref 时成立，用来提醒模型“旧逻辑被拿掉了什么”。
      const previousPath = diff.oldPath || diff.path;
      const previousFileContent = await this.getFileContent(owner, repo, previousPath, options.baselineRef);
      if (previousFileContent) {
        const removedScopes = await this.codeAnalyzer.analyzeRemovedScopes(previousPath, previousFileContent, diff);
        this.distributeDeletedScopes(removedScopes, context, ragProfile);
      }
    }

    return context;
  }

  private async resolveSymbolContext(
    owner: string,
    repo: string,
    currentPath: string,
    candidate: IdentifierCandidate,
    targetRef: string,
    ragProfile: ReviewFileRagStrategy
  ): Promise<ResolvedSymbolContext | null> {
    // 远程符号解析可能被多个候选路径共用，缓存 Promise 可以天然合并并发请求。
    const cacheKey = `${owner}/${repo}:${targetRef}:${currentPath}:${candidate.name}`;
    let pending = this.symbolCache.get(cacheKey);
    if (!pending) {
      pending = this.loadRemoteSymbolContext(owner, repo, currentPath, candidate, targetRef, ragProfile);
      this.symbolCache.set(cacheKey, pending);
    }

    return pending;
  }

  private async loadRemoteSymbolContext(
    owner: string,
    repo: string,
    currentPath: string,
    candidate: IdentifierCandidate,
    targetRef: string,
    ragProfile: ReviewFileRagStrategy
  ): Promise<ResolvedSymbolContext | null> {
    // 搜索结果也单独缓存，因为同一个符号名常常会在多个 review segment 中重复出现。
    const searchKey = `${owner}/${repo}:${candidate.name}`;
    let pendingSearch = this.searchCache.get(searchKey);
    if (!pendingSearch) {
      pendingSearch = this.scmProvider.searchCode(owner, repo, candidate.name);
      this.searchCache.set(searchKey, pendingSearch);
    }

    const candidatePaths = (await pendingSearch)
      .filter((filePath) => filePath !== currentPath)
      .slice(0, ragProfile.maxSearchResultsPerLookup);

    for (const filePath of candidatePaths) {
      // 找到首个能解析出目标符号定义的文件就返回，保持远程上下文尽量短。
      const content = await this.getFileContent(owner, repo, filePath, targetRef);
      if (!content) {
        continue;
      }

      const symbols = await this.codeAnalyzer.extractSymbol(filePath, content, [candidate.name]);
      if (symbols.length > 0) {
        return { path: filePath, symbols };
      }
    }

    return null;
  }

  private distributeSymbols(
    symbols: ExtractedSymbol[],
    context: CodeContext,
    sourcePath: string,
    ragProfile: ReviewFileRagStrategy
  ): void {
    // 函数/类型分开限流，避免某一类上下文把有限的 prompt 预算全部占满。
    for (const symbol of symbols) {
      const isTypeSymbol = symbol.type === 'interface';
      const target = isTypeSymbol ? context.types : context.functions;
      const limit = isTypeSymbol ? ragProfile.maxTypeContexts : ragProfile.maxFunctionContexts;
      if (target.length >= limit) {
        continue;
      }

      if (target.some((item) => item.name === symbol.name && item.file === sourcePath)) {
        continue;
      }

      target.push({
        name: symbol.name,
        content: symbol.content,
        file: sourcePath,
      });
    }
  }

  private distributeSemanticSlices(
    slices: CodeContext['semanticSlices'],
    context: CodeContext,
    ragProfile: ReviewFileRagStrategy
  ): void {
    // 语义切片是“摘要型上下文”，比完整符号定义更轻，因此单独控制数量上限。
    for (const slice of slices) {
      if (context.semanticSlices.length >= ragProfile.maxSemanticSlices) {
        return;
      }

      if (context.semanticSlices.some((item) => item.label === slice.label && item.file === slice.file && item.content === slice.content)) {
        continue;
      }

      context.semanticSlices.push(slice);
    }
  }

  private distributeDeletedScopes(
    deletedScopes: CodeContext['deletedScopes'],
    context: CodeContext,
    ragProfile: ReviewFileRagStrategy
  ): void {
    // 删除上下文通常价值很高，但也容易造成噪音，因此只保留少量高优先级片段。
    for (const scope of deletedScopes) {
      if (context.deletedScopes.length >= ragProfile.maxDeletedScopeContexts) {
        return;
      }

      context.deletedScopes.push(scope);
    }
  }

  private async getFileContent(owner: string, repo: string, filePath: string, ref: string): Promise<string> {
    // 远程文件内容读取是整个 RAG 阶段最常见的 I/O，按 owner/repo/ref/path 做强缓存。
    const cacheKey = `${owner}/${repo}:${ref}:${filePath}`;
    let pending = this.fileContentCache.get(cacheKey);
    if (!pending) {
      pending = this.scmProvider.getFileContent(owner, repo, filePath, ref);
      this.fileContentCache.set(cacheKey, pending);
    }

    return pending;
  }

  private getRagProfile(
    diff: FileDiff,
    initialSignals: ReviewSignal[],
    strategy?: ReviewFileStrategy
  ): ReviewFileRagStrategy {
    // profile 不是静态配置直通，而是会根据文件状态和现有信号做二次裁剪。
    // 例如已有高置信度 signal 时，减少远程 symbol hop，把预算留给生成阶段。
    const baseProfile = strategy?.rag ?? RAGEngine.DEFAULT_RAG_PROFILE;
    const isDeletedOrRenameHeavy = diff.status === 'deleted'
      || diff.chunks.every((chunk) => chunk.newRange.lines === 0);
    const hasHighConfidenceSignals = initialSignals.length > 0;

    return {
      ...baseProfile,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxRemoteSymbolLookups: hasHighConfidenceSignals
        ? Math.max(1, baseProfile.maxRemoteSymbolLookups - 1)
        : baseProfile.maxRemoteSymbolLookups,
      maxFunctionContexts: baseProfile.allowCodeContext
        ? baseProfile.maxFunctionContexts
        : 0,
      maxTypeContexts: baseProfile.allowCodeContext
        ? baseProfile.maxTypeContexts
        : 0,
      maxSemanticSlices: baseProfile.allowCodeContext
        ? baseProfile.maxSemanticSlices
        : 0,
      maxDeletedScopeContexts: baseProfile.allowCodeContext
        ? (isDeletedOrRenameHeavy ? Math.max(baseProfile.maxDeletedScopeContexts, 2) : baseProfile.maxDeletedScopeContexts)
        : 0,
    };
  }
}
