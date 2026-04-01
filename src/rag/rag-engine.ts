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
  private symbolCache = new LRUCache<string, Promise<ResolvedSymbolContext | null>>({ max: 256 });
  private fileContentCache = new LRUCache<string, Promise<string>>({ max: 256 });
  private searchCache = new LRUCache<string, Promise<string[]>>({ max: 128 });

  constructor(
    private scmProvider: ISCMProvider,
    private repositoryRoot?: string
  ) {}

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
    const fallbackSegments = splitDiffIntoReviewSegments(diff, { maxGapLines: 24, maxSegments });
    if (diff.chunks.length <= 1) {
      return fallbackSegments;
    }

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
      this.distributeSemanticSlices(
        this.structuredFileAnalyzer.analyze(diff.path, currentFileContent, diff),
        context,
        ragProfile
      );
    }

    if (!ragProfile.allowCodeContext) {
      return context;
    }

    const diffAnalysis = currentFileContent
      ? await this.codeAnalyzer.analyzeFileDiff(diff.path, currentFileContent, diff)
      : { identifiers: CodeAnalyzer.getPotentialIdentifiers(diffContent), localSymbols: [], semanticSlices: [] };
    const identifierCandidates = diffAnalysis.identifiers;

    if (diffAnalysis.localSymbols.length > 0) {
      this.distributeSymbols(diffAnalysis.localSymbols, context, 'current', ragProfile);
    }

    if (diffAnalysis.semanticSlices.length > 0) {
      this.distributeSemanticSlices(diffAnalysis.semanticSlices, context, ragProfile);
    }

    if (currentFileContent && identifierCandidates.length > 0) {
      const symbols = await this.codeAnalyzer.extractSymbol(
        diff.path,
        currentFileContent,
        identifierCandidates.map((candidate) => candidate.name)
      );
      this.distributeSymbols(symbols, context, 'current', ragProfile);
    }

    if (ragProfile.allowRemoteSymbolSearch && config.MAX_RAG_HOPS > 0) {
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
    for (const scope of deletedScopes) {
      if (context.deletedScopes.length >= ragProfile.maxDeletedScopeContexts) {
        return;
      }

      context.deletedScopes.push(scope);
    }
  }

  private async getFileContent(owner: string, repo: string, filePath: string, ref: string): Promise<string> {
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
