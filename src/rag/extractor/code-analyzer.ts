/**
 * 提供代码级符号提取与 diff 语义分析能力。
 *
 * 这个文件负责从变更文件中提取本地符号、候选标识符和变更作用域，
 * 供 RAG 阶段进一步扩展上下文。
 */
import { SyntaxKind, tsquery } from '@phenomnomnominal/tsquery';
import type {
  ImportDeclaration,
  Node as TsNode,
  SourceFile as TsSourceFile,
  StringLiteral,
  VariableStatement,
} from 'typescript';
import { Node as TsMorphNode, Project, SourceFile } from 'ts-morph';
import { CodeContextSnippet, DeletedCodeContext, FileDiff } from '../../types/index.js';
import {
  getChangedNewLineAnchors,
  getRemovedOldLineEntries,
  getTouchedNewLineEntries,
  splitDiffIntoReviewSegments,
} from '../../core/review/diff-utils.js';
import { getScriptKindForFile } from '../../core/review/script-file-utils.js';
import { logger } from '../../shared/logger.js';

/**
 * 表示从源码里提取出的局部符号及其可注入上下文。
 */
export interface ExtractedSymbol {
  name: string;
  content: string;
  type: 'function' | 'interface' | 'class';
}

/**
 * 表示 diff 中值得继续追踪的标识符候选及其相关性分数。
 */
export interface IdentifierCandidate {
  name: string;
  score: number;
  importSource?: string;
}

/**
 * 汇总单文件 diff 的标识符、符号和语义切片分析结果。
 */
export interface FileDiffAnalysis {
  identifiers: IdentifierCandidate[];
  localSymbols: ExtractedSymbol[];
  semanticSlices: CodeContextSnippet[];
}

interface SemanticScopeDescriptor {
  key: string;
  label: string;
  name?: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * 结合 TypeScript Compiler API、ts-morph 和 tsquery 对代码 diff 进行结构化分析。
 */
export class CodeAnalyzer {
  // 这些关键字出现在 diff 里时经常只是语法噪音，不值得作为跨文件检索候选。
  private static readonly EXCLUDED_IDENTIFIERS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'await',
    'async',
    'const',
    'let',
    'var',
    'true',
    'false',
    'null',
    'undefined',
    'import',
    'export',
    'from',
    'default',
    'type',
    'new',
    'extends',
    'implements',
    'function',
    'class',
    'interface',
    'console',
  ]);
  private project: Project;

  /**
   * 创建代码分析器，并初始化内存内 TypeScript 项目。
   */
  constructor() {
    this.project = new Project({ useInMemoryFileSystem: true });
  }

  /**
   * 优先按语义容器拆分 diff；如果语义分段收益不明显，则回退到按行距切段。
   *
   * 目标不是绝对精确地还原执行流，而是尽量让一个 review segment 落在同一个函数、
   * 方法或类作用域内，这样 prompt 的上下文更聚焦。
   */
  async segmentDiffBySemanticScope(
    filePath: string,
    content: string,
    diff: FileDiff,
    options: {
      maxGapLines?: number;
      maxSegments?: number;
    } = {}
  ): Promise<FileDiff[]> {
    const fallbackSegments = splitDiffIntoReviewSegments(diff, options);
    if (!content || diff.chunks.length <= 1) {
      return fallbackSegments;
    }

    try {
      const sourceFile = tsquery.ast(content, filePath, getScriptKindForFile(filePath));
      const groupedChunks: Array<{
        key: string;
        label: string;
        chunks: typeof diff.chunks;
      }> = [];

      for (const chunk of diff.chunks) {
        const descriptor = this.findSemanticScopeForChunk(sourceFile, chunk);
        const chunkKey = descriptor?.key ?? `chunk:${chunk.newRange.start}:${chunk.oldRange.start}`;
        const chunkLabel = descriptor?.label ?? '局部变更';
        const previousGroup = groupedChunks[groupedChunks.length - 1];

        if (previousGroup && previousGroup.key === chunkKey) {
          previousGroup.chunks.push(chunk);
          continue;
        }

        groupedChunks.push({
          key: chunkKey,
          label: chunkLabel,
          chunks: [chunk],
        });
      }

      if (groupedChunks.length <= 1 || groupedChunks.length > (options.maxSegments ?? 4)) {
        return fallbackSegments;
      }

      return groupedChunks.map((group) => ({
        ...diff,
        chunks: group.chunks,
      }));
    } catch (error: unknown) {
      logger.warn(`semantic diff segmentation failed for ${filePath}, falling back to line-gap split: ${CodeAnalyzer.getErrorMessage(error)}`);
      return fallbackSegments;
    }
  }

  /**
   * 在特定文件中提取特定符号的定义
   *
   * 这里面向的是“已知符号名 -> 找定义”场景，因此不会做全文件遍历式导出分析，
   * 只按函数、接口、类型、类和函数变量这些高价值节点做定向提取。
   */
  async extractSymbol(filePath: string, content: string, symbols: string[]): Promise<ExtractedSymbol[]> {
    if (!content || symbols.length === 0) return [];

    let sourceFile: SourceFile;
    try {
      // 在内存中载入文件
      sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    } catch (e) {
      logger.error(`Failed to parse file: ${filePath}`, e);
      return [];
    }

    const results: ExtractedSymbol[] = [];

    for (const symbolName of symbols) {
      // 1. 查找函数定义
      const func = sourceFile.getFunction(symbolName);
      if (func) {
        results.push({ name: symbolName, content: func.getText(), type: 'function' });
        continue;
      }

      // 2. 查找接口或类型定义
      const iface = sourceFile.getInterface(symbolName);
      if (iface) {
        results.push({ name: symbolName, content: iface.getText(), type: 'interface' });
        continue;
      }

      const alias = sourceFile.getTypeAlias(symbolName);
      if (alias) {
        results.push({ name: symbolName, content: alias.getText(), type: 'interface' });
        continue;
      }

      // 3. 查找类定义
      const cls = sourceFile.getClass(symbolName);
      if (cls) {
        // 为了节省预算，只提取类的核心骨架（不提取所有方法体，可以根据实际调整）
        results.push({ name: symbolName, content: cls.getText(), type: 'class' });
        continue;
      }

      const variable = sourceFile.getVariableDeclaration(symbolName);
      if (variable) {
        const initializer = variable.getInitializer();
        if (initializer && (TsMorphNode.isArrowFunction(initializer) || TsMorphNode.isFunctionExpression(initializer))) {
          results.push({
            name: symbolName,
            content: variable.getVariableStatement()?.getText() || variable.getText(),
            type: 'function',
          });
          continue;
        }
      }
    }

    return results;
  }

  /**
   * 分析单个文件 diff，产出候选标识符和本地定义符号。
   *
   * 这是 RAG 的主入口之一：先用 AST 找到变更作用域，再把局部符号、语义切片和
   * 候选标识符一起返回，供上层决定是否继续跨文件扩展。
   */
  async analyzeFileDiff(filePath: string, content: string, diff: FileDiff): Promise<FileDiffAnalysis> {
    const diffContent = diff.chunks.map((chunk) => chunk.content).join('\n');
    const fallbackIdentifiers = CodeAnalyzer.getPotentialIdentifiers(diffContent);
    const touchedLines = getTouchedNewLineEntries(diff);
    const changedLineAnchors = getChangedNewLineAnchors(diff);

    if (!content || changedLineAnchors.length === 0) {
      return { identifiers: fallbackIdentifiers, localSymbols: [], semanticSlices: [] };
    }

    try {
      const sourceFile = tsquery.ast(content, filePath, getScriptKindForFile(filePath));
      const morphSourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
      const changedLineNumbers = new Set(changedLineAnchors);
      const scopeNodes = this.selectChangedScopeNodes(sourceFile, changedLineNumbers);
      const localSymbols = this.extractLocalSymbols(scopeNodes);
      const semanticSlices = this.extractSemanticSlices(
        filePath,
        sourceFile,
        morphSourceFile,
        scopeNodes,
        localSymbols
      );

      // 候选标识符采用“多来源累积分”的方式排序：
      // import 命中、调用点命中、类型引用命中和 diff 文本启发式都会叠加分数。
      const rankedCandidates = new Map<string, IdentifierCandidate>();
      const changedWindowText = [
        touchedLines.map((entry) => entry.text).join('\n'),
        ...scopeNodes.slice(0, 3).map((node) => node.getText()),
      ].join('\n');

      const addCandidate = (rawName: string, score: number, importSource?: string) => {
        const name = rawName.trim();
        if (!CodeAnalyzer.isUsefulIdentifier(name)) {
          return;
        }

        const existing = rankedCandidates.get(name);
        if (existing) {
          existing.score += score;
          if (!existing.importSource && importSource) {
            existing.importSource = importSource;
          }
          return;
        }

        rankedCandidates.set(name, { name, score, importSource });
      };

      for (const importDeclaration of tsquery.query<ImportDeclaration>(sourceFile, 'ImportDeclaration')) {
        const moduleSpecifier = this.getImportModuleSpecifier(importDeclaration);
        if (!moduleSpecifier) {
          continue;
        }

        for (const importedName of this.getImportedBindings(importDeclaration)) {
          if (changedWindowText.includes(importedName)) {
            addCandidate(importedName, 12, moduleSpecifier);
          }
        }
      }

      const semanticIdentifierSelector = [
        'CallExpression > Identifier',
        'NewExpression > Identifier',
        'TypeReference > Identifier',
        'ExpressionWithTypeArguments > Identifier',
        'HeritageClause Identifier',
      ].join(', ');

      for (const scopeNode of scopeNodes.slice(0, 4)) {
        for (const identifierNode of tsquery.query<TsNode>(scopeNode, semanticIdentifierSelector)) {
          addCandidate(identifierNode.getText(), 7);
        }
      }

      for (const fallback of fallbackIdentifiers) {
        addCandidate(fallback.name, fallback.score, fallback.importSource);
      }

      return {
        identifiers: Array.from(rankedCandidates.values()).sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return left.name.localeCompare(right.name);
        }),
        localSymbols,
        semanticSlices,
      };
    } catch (error: unknown) {
      logger.warn(`tsquery analysis failed for ${filePath}, falling back to heuristic extraction: ${CodeAnalyzer.getErrorMessage(error)}`);
      return { identifiers: fallbackIdentifiers, localSymbols: [], semanticSlices: [] };
    }
  }

  /**
   * 基于旧版本文件内容提取被删除或被削弱的关键作用域，帮助 review 感知回归风险。
   */
  async analyzeRemovedScopes(filePath: string, content: string, diff: FileDiff): Promise<DeletedCodeContext[]> {
    const removedEntries = getRemovedOldLineEntries(diff);
    if (!content || removedEntries.length === 0) {
      return [];
    }

    try {
      const sourceFile = tsquery.ast(content, filePath, getScriptKindForFile(filePath));
      const removedLines = new Set(removedEntries.map((entry) => entry.line));
      const scopeNodes = this.selectChangedScopeNodes(sourceFile, removedLines);
      const contexts: DeletedCodeContext[] = [];

      for (const scopeNode of scopeNodes.slice(0, 4)) {
        const { startLine, endLine } = this.getNodeLineRange(sourceFile, scopeNode);
        const removedTexts = removedEntries
          .filter((entry) => entry.line >= startLine && entry.line <= endLine)
          .map((entry) => entry.text)
          .filter(Boolean);
        const reason = this.describeRemovedBehavior(removedTexts);
        const name = this.getNodeName(scopeNode) ?? undefined;

        contexts.push({
          name,
          reason,
          content: scopeNode.getText(),
          file: filePath,
        });
      }

      return contexts;
    } catch (error: unknown) {
      logger.warn(`removed scope analysis failed for ${filePath}: ${CodeAnalyzer.getErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * 从 Diff 中提取高置信度标识符，优先保留 import、调用点和类型引用。
   *
   * 这是 AST 分析失败时的兜底方案，同时也会作为补充信号与 AST 结果合并。
   */
  static getPotentialIdentifiers(content: string): IdentifierCandidate[] {
    const rankedCandidates = new Map<string, IdentifierCandidate>();
    const signalLines = content
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
    const signalContent = signalLines.length > 0 ? signalLines.join('\n') : content;

    const addCandidate = (rawName: string, score: number, importSource?: string) => {
      const name = rawName.trim();
      if (!this.isUsefulIdentifier(name)) {
        return;
      }

      const existing = rankedCandidates.get(name);
      if (existing) {
        existing.score += score;
        if (!existing.importSource && importSource) {
          existing.importSource = importSource;
        }
        return;
      }

      rankedCandidates.set(name, { name, score, importSource });
    };

    for (const match of signalContent.matchAll(/import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g)) {
      const specifiers = match[1].split(',').map((part) => part.trim()).filter(Boolean);
      for (const specifier of specifiers) {
        addCandidate(specifier.replace(/^type\s+/, '').split(/\s+as\s+/i)[0], 10, match[2]);
      }
    }

    for (const match of signalContent.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*{[^}]+})?\s+from\s+['"]([^'"]+)['"]/g)) {
      addCandidate(match[1], 9, match[2]);
    }

    for (const match of signalContent.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g)) {
      addCandidate(match[1], 7, match[2]);
    }

    for (const match of signalContent.matchAll(/\b([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
      addCandidate(match[1], 6);
    }

    for (const match of signalContent.matchAll(/\b(?:extends|implements|new|as)\s+([A-Z][A-Za-z0-9_$]*)/g)) {
      addCandidate(match[1], 7);
    }

    for (const match of signalContent.matchAll(/:\s*([A-Z][A-Za-z0-9_$]*)\b/g)) {
      addCandidate(match[1], 6);
    }

    for (const match of signalContent.matchAll(/<([A-Z][A-Za-z0-9_$]*)\b/g)) {
      addCandidate(match[1], 5);
    }

    for (const match of signalContent.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
      addCandidate(match[1], 2);
    }

    return Array.from(rankedCandidates.values()).sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.name.localeCompare(right.name);
    });
  }

  /**
   * 判断某个标识符是否值得继续追踪。
   */
  private static isUsefulIdentifier(name: string): boolean {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.length < 2) {
      return false;
    }

    return !this.EXCLUDED_IDENTIFIERS.has(name);
  }

  /**
   * 为单个 diff chunk 查找最贴近的语义作用域，供语义分段使用。
   */
  private findSemanticScopeForChunk(sourceFile: TsSourceFile, chunk: FileDiff['chunks'][number]): SemanticScopeDescriptor | null {
    const anchorLines = this.getChunkAnchorLines(chunk);
    if (anchorLines.size === 0) {
      return null;
    }

    const scopeNode = this.selectChangedScopeNodes(sourceFile, anchorLines)[0];
    if (!scopeNode) {
      return null;
    }

    const { startLine, endLine } = this.getNodeLineRange(sourceFile, scopeNode);
    const name = this.getNodeName(scopeNode) ?? undefined;
    const scopeKind = this.getSemanticScopeKindLabel(scopeNode.kind);
    return {
      key: `${scopeKind}:${name || startLine}:${startLine}:${endLine}`,
      label: name ? `${scopeKind} ${name}` : scopeKind,
      name,
      startLine,
      endLine,
      text: scopeNode.getText(),
    };
  }

  /**
   * 使用 TypeScript AST 提取变更涉及的最小语义作用域节点。
   *
   * 这里会优先选择更“小”的节点，并剔除被更大节点完全包裹的重复候选，
   * 目的是让提取到的上下文尽量聚焦。
   */
  private selectChangedScopeNodes(sourceFile: TsSourceFile, touchedLines: Set<number>): TsNode[] {
    const candidateSelector = [
      'FunctionDeclaration',
      'MethodDeclaration',
      'ClassDeclaration',
      'InterfaceDeclaration',
      'TypeAliasDeclaration',
      'EnumDeclaration',
      'VariableStatement',
    ].join(', ');

    const candidates = tsquery.query<TsNode>(sourceFile, candidateSelector)
      .filter((node) => this.isChangedScopeNode(sourceFile, node, touchedLines))
      .sort((left, right) => {
        const leftSpan = left.getEnd() - left.getStart(sourceFile);
        const rightSpan = right.getEnd() - right.getStart(sourceFile);
        return leftSpan - rightSpan;
      });

    const selected: TsNode[] = [];
    for (const candidate of candidates) {
      if (selected.some((existing) => this.nodeContains(existing, candidate, sourceFile))) {
        continue;
      }

      selected.push(candidate);
      if (selected.length >= 4) {
        break;
      }
    }

    return selected;
  }

  /**
   * 判断一个 tsquery 节点是否与本次 diff 的新增行重叠。
   *
   * `VariableStatement` 会额外过滤，只把函数变量视为语义作用域，避免普通常量声明
   * 被误当成值得单独注入 prompt 的上下文块。
   */
  private isChangedScopeNode(sourceFile: TsSourceFile, node: TsNode, touchedLines: Set<number>): boolean {
    if (node.kind === SyntaxKind.VariableStatement) {
      const statement = node as VariableStatement;
      const declaration = statement.declarationList.declarations[0];
      const initializer = declaration?.initializer;
      if (!initializer) {
        return false;
      }

      if (initializer.kind !== SyntaxKind.ArrowFunction && initializer.kind !== SyntaxKind.FunctionExpression) {
        return false;
      }
    }

    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    for (const line of touchedLines) {
      if (line >= startLine && line <= endLine) {
        return true;
      }
    }

    return false;
  }

  /**
   * 从 tsquery 作用域节点里提取本地符号定义。
   */
  private extractLocalSymbols(scopeNodes: TsNode[]): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const seenNames = new Set<string>();

    for (const node of scopeNodes) {
      const symbol = this.extractLocalSymbolFromNode(node);
      if (!symbol || seenNames.has(symbol.name)) {
        continue;
      }

      seenNames.add(symbol.name);
      symbols.push(symbol);
    }

    return symbols;
  }

  /**
   * 从当前文件的变更作用域中提取关键保护分支和同文件依赖，形成轻量语义切片。
   *
   * 这些切片比完整函数定义更短，适合在 prompt 预算有限时补充“这个作用域依赖了什么、
   * 保护了什么、数据往哪里流”。
   */
  private extractSemanticSlices(
    filePath: string,
    sourceFile: TsSourceFile,
    morphSourceFile: SourceFile,
    scopeNodes: TsNode[],
    localSymbols: ExtractedSymbol[]
  ): CodeContextSnippet[] {
    const slices: CodeContextSnippet[] = [];
    const seenKeys = new Set<string>();
    const localSymbolNames = new Set(localSymbols.map((symbol) => symbol.name));
    const helperCandidateNames = new Set<string>();

    const addSlice = (label: string, content: string) => {
      const normalized = content.trim();
      if (!normalized) {
        return;
      }

      const key = `${label}:${normalized}`;
      if (seenKeys.has(key)) {
        return;
      }

      seenKeys.add(key);
      slices.push({ label, content: normalized, file: filePath });
    };

    for (const scopeNode of scopeNodes.slice(0, 3)) {
      const callChainSummary = this.buildCallChainSummary(scopeNode, morphSourceFile);
      if (callChainSummary) {
        addSlice('调用链摘要', callChainSummary);
      }

      const dataFlowSummary = this.buildDataFlowSummary(scopeNode);
      if (dataFlowSummary) {
        addSlice('数据流摘要', dataFlowSummary);
      }

      for (const ifNode of tsquery.query<TsNode>(scopeNode, 'IfStatement')) {
        const text = ifNode.getText();
        if (/\b(return|throw)\b/.test(text)) {
          addSlice('关键保护分支', text);
        }
        if (slices.length >= 2) {
          break;
        }
      }

      for (const identifierNode of tsquery.query<TsNode>(
        scopeNode,
        'CallExpression > Identifier, NewExpression > Identifier, TypeReference > Identifier'
      )) {
        helperCandidateNames.add(identifierNode.getText());
      }
    }

    const helperSymbols = this.extractSymbolsFromMorphSourceFile(
      morphSourceFile,
      Array.from(helperCandidateNames).filter((name) => !localSymbolNames.has(name))
    );

    for (const helperSymbol of helperSymbols.slice(0, 4)) {
      addSlice(helperSymbol.type === 'function' ? '同文件依赖函数' : '同文件依赖类型', helperSymbol.content);
    }

    return slices.slice(0, 6);
  }

  /**
   * 生成当前作用域的一跳/二跳调用链摘要，帮助 prompt 理解真实执行链。
   *
   * 这里故意只追两跳，并且限制每跳数量，避免把摘要膨胀成另一份完整代码。
   */
  private buildCallChainSummary(scopeNode: TsNode, sourceFile: SourceFile): string | null {
    const entryName = this.getNodeName(scopeNode) || '匿名作用域';
    const directCallees = this.extractCallExpressionNames(scopeNode)
      .filter((name) => CodeAnalyzer.isUsefulIdentifier(name))
      .slice(0, 5);

    if (directCallees.length === 0) {
      return null;
    }

    const lines = [
      `入口: ${entryName}`,
      `直接调用: ${directCallees.join(', ')}`,
    ];

    const secondHopSummaries: string[] = [];
    for (const callee of directCallees.slice(0, 3)) {
      const definition = this.extractSymbolsFromMorphSourceFile(sourceFile, [callee])[0];
      if (!definition || definition.type !== 'function') {
        continue;
      }

      const secondHop = CodeAnalyzer.getPotentialIdentifiers(definition.content)
        .map((candidate) => candidate.name)
        .filter((name) => name !== callee && CodeAnalyzer.isUsefulIdentifier(name))
        .slice(0, 3);
      if (secondHop.length > 0) {
        secondHopSummaries.push(`${callee} -> ${secondHop.join(', ')}`);
      }
    }

    if (secondHopSummaries.length > 0) {
      lines.push('二跳调用:');
      lines.push(...secondHopSummaries.map((item) => `- ${item}`));
    }

    return lines.join('\n');
  }

  /**
   * 生成当前作用域的轻量数据流摘要，突出参数、保护条件和敏感下游调用。
   *
   * 它不做严格的数据流分析，只做“足够便宜但有用”的启发式提炼，用来提示模型关注
   * 输入、保护分支和可能产生副作用的调用。
   */
  private buildDataFlowSummary(scopeNode: TsNode): string | null {
    const parameterNames = this.extractParameterNames(scopeNode);
    const calleeNames = this.extractCallExpressionNames(scopeNode);
    const sensitiveCalls = calleeNames.filter((name) => /^(set[A-Z]|update|insert|delete|query|execute|fetch|post|put|patch|redirect|send|emit)/.test(name));
    const guardSummaries = tsquery.query<TsNode>(scopeNode, 'IfStatement')
      .map((node) => node.getText().split('\n')[0].trim())
      .filter((text) => /\b(return|throw)\b/.test(text))
      .slice(0, 2);

    if (parameterNames.length === 0 && sensitiveCalls.length === 0 && guardSummaries.length === 0) {
      return null;
    }

    const lines: string[] = [];
    if (parameterNames.length > 0) {
      lines.push(`输入参数: ${parameterNames.join(', ')}`);
    }
    if (guardSummaries.length > 0) {
      lines.push(`保护条件: ${guardSummaries.join(' | ')}`);
    }

    if (sensitiveCalls.length > 0) {
      const flowedParameters = parameterNames.filter((name) => scopeNode.getText().includes(name));
      lines.push(`敏感调用: ${Array.from(new Set(sensitiveCalls)).slice(0, 5).join(', ')}`);
      if (flowedParameters.length > 0) {
        lines.push(`可能参与下游调用的输入: ${flowedParameters.slice(0, 5).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 把单个 tsquery 节点映射成内部统一的符号结构。
   */
  private extractLocalSymbolFromNode(node: TsNode): ExtractedSymbol | null {
    switch (node.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration: {
        const name = this.getNodeName(node);
        return name ? { name, content: node.getText(), type: 'function' } : null;
      }
      case SyntaxKind.VariableStatement: {
        const statement = node as VariableStatement;
        const declaration = statement.declarationList.declarations[0];
        const initializer = declaration?.initializer;
        if (!initializer) {
          return null;
        }

        if (initializer.kind !== SyntaxKind.ArrowFunction && initializer.kind !== SyntaxKind.FunctionExpression) {
          return null;
        }

        const name = declaration.name.getText();
        return name ? { name, content: statement.getText(), type: 'function' } : null;
      }
      case SyntaxKind.ClassDeclaration: {
        const name = this.getNodeName(node);
        return name ? { name, content: node.getText(), type: 'class' } : null;
      }
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration: {
        const name = this.getNodeName(node);
        return name ? { name, content: node.getText(), type: 'interface' } : null;
      }
      default:
        return null;
    }
  }

  /**
   * 使用已经载入的 ts-morph SourceFile 解析本文件内的依赖定义，避免重复建 AST。
   *
   * 这一步只在同文件依赖提取时使用，属于低成本补充，不会跨文件扩散。
   */
  private extractSymbolsFromMorphSourceFile(sourceFile: SourceFile, symbols: string[]): ExtractedSymbol[] {
    const results: ExtractedSymbol[] = [];
    const seen = new Set<string>();

    for (const symbolName of symbols) {
      if (!symbolName || seen.has(symbolName)) {
        continue;
      }

      const func = sourceFile.getFunction(symbolName);
      if (func) {
        results.push({ name: symbolName, content: func.getText(), type: 'function' });
        seen.add(symbolName);
        continue;
      }

      const iface = sourceFile.getInterface(symbolName);
      if (iface) {
        results.push({ name: symbolName, content: iface.getText(), type: 'interface' });
        seen.add(symbolName);
        continue;
      }

      const alias = sourceFile.getTypeAlias(symbolName);
      if (alias) {
        results.push({ name: symbolName, content: alias.getText(), type: 'interface' });
        seen.add(symbolName);
        continue;
      }

      const cls = sourceFile.getClass(symbolName);
      if (cls) {
        results.push({ name: symbolName, content: cls.getText(), type: 'class' });
        seen.add(symbolName);
        continue;
      }

      const variable = sourceFile.getVariableDeclaration(symbolName);
      const initializer = variable?.getInitializer();
      if (variable && initializer && (TsMorphNode.isArrowFunction(initializer) || TsMorphNode.isFunctionExpression(initializer))) {
        results.push({
          name: symbolName,
          content: variable.getVariableStatement()?.getText() || variable.getText(),
          type: 'function',
        });
        seen.add(symbolName);
      }
    }

    return results;
  }

  /**
   * 提取当前作用域内的一组直接调用名，用于调用链与框架语义分析。
   */
  private extractCallExpressionNames(scopeNode: TsNode): string[] {
    const names = new Set<string>();

    for (const identifierNode of tsquery.query<TsNode>(
      scopeNode,
      'CallExpression > Identifier, NewExpression > Identifier'
    )) {
      names.add(identifierNode.getText());
    }

    return Array.from(names);
  }

  /**
   * 提取函数或方法作用域的参数名，用于轻量数据流摘要。
   */
  private extractParameterNames(scopeNode: TsNode): string[] {
    const parameterNodes = tsquery.query<TsNode>(scopeNode, 'Parameter Identifier');
    const names = parameterNodes
      .map((node) => node.getText())
      .filter((name) => CodeAnalyzer.isUsefulIdentifier(name));

    return Array.from(new Set(names)).slice(0, 6);
  }

  /**
   * 读取 tsquery 命名节点的名称文本。
   */
  private getNodeName(node: TsNode): string | null {
    const namedNode = node as TsNode & { name?: { getText(): string } };
    if (namedNode.name && typeof namedNode.name.getText === 'function') {
      return namedNode.name.getText();
    }

    return null;
  }

  /**
   * 读取 tsquery 节点对应的起止行号，便于做语义作用域和删除范围映射。
   */
  private getNodeLineRange(sourceFile: TsSourceFile, node: TsNode): { startLine: number; endLine: number } {
    return {
      startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    };
  }

  /**
   * 根据 diff chunk 新旧侧行号生成语义分段所需的锚点集合。
   */
  private getChunkAnchorLines(chunk: FileDiff['chunks'][number]): Set<number> {
    const anchors = new Set<number>();
    const chunkLines = chunk.content.replace(/\r\n/g, '\n').split('\n');
    let nextNewLine = chunk.newRange.start;

    for (const line of chunkLines) {
      if (!line || line.startsWith('@@') || line.startsWith('\\')) {
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        anchors.add(nextNewLine);
        nextNewLine += 1;
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        continue;
      }

      nextNewLine += 1;
    }

    if (anchors.size === 0) {
      anchors.add(Math.max(1, chunk.newRange.start));
      anchors.add(Math.max(1, chunk.newRange.start + Math.max(chunk.newRange.lines, 1) - 1));
    }

    return anchors;
  }

  /**
   * 把语法节点 kind 映射成更适合日志和 prompt 的语义标签。
   */
  private getSemanticScopeKindLabel(kind: SyntaxKind): string {
    switch (kind) {
      case SyntaxKind.FunctionDeclaration:
        return '函数';
      case SyntaxKind.MethodDeclaration:
        return '方法';
      case SyntaxKind.ClassDeclaration:
        return '类';
      case SyntaxKind.InterfaceDeclaration:
        return '接口';
      case SyntaxKind.TypeAliasDeclaration:
        return '类型';
      case SyntaxKind.EnumDeclaration:
        return '枚举';
      case SyntaxKind.VariableStatement:
        return '函数变量';
      default:
        return '语义块';
    }
  }

  /**
   * 根据被删掉的语句模式，生成更贴近 review 关注点的旧逻辑摘要。
   *
   * 删除上下文的目标不是还原全部旧行为，而是告诉模型“删掉的是保护逻辑、隔离条件，
   * 还是并发/事务控制”，从而提高对回归风险的敏感度。
   */
  private describeRemovedBehavior(removedTexts: string[]): string {
    const joined = removedTexts.join('\n').toLowerCase();

    if (/\b(auth|permission|role|acl|session|token|tenant)\b/.test(joined)) {
      return '删除了鉴权、权限或租户隔离相关逻辑';
    }

    if (/\b(transaction|commit|rollback|lock|mutex|semaphore)\b/.test(joined)) {
      return '删除了事务、锁或并发保护相关逻辑';
    }

    if (/\b(where|filter|scope|owner|status|deleted|isactive)\b/.test(joined)) {
      return '删除了过滤条件、范围约束或数据隔离逻辑';
    }

    if (/\b(if|else|return|throw|catch|guard|assert|ensure)\b/.test(joined)) {
      return '删除了条件分支、兜底或保护性判断';
    }

    return '删除了该作用域中的旧逻辑';
  }

  /**
   * 判断一个 tsquery 节点是否完全包裹另一个节点。
   */
  private nodeContains(outer: TsNode, inner: TsNode, sourceFile: TsSourceFile): boolean {
    return outer !== inner
      && outer.getStart(sourceFile) <= inner.getStart(sourceFile)
      && outer.getEnd() >= inner.getEnd();
  }

  /**
   * 提取 import 声明的模块路径。
   */
  private getImportModuleSpecifier(importDeclaration: ImportDeclaration): string | null {
    const moduleSpecifier = importDeclaration.moduleSpecifier as StringLiteral | undefined;
    return typeof moduleSpecifier?.text === 'string' ? moduleSpecifier.text : null;
  }

  /**
   * 提取 import 声明里出现的所有绑定名称。
   */
  private getImportedBindings(importDeclaration: ImportDeclaration): string[] {
    const bindings: string[] = [];
    const clause = importDeclaration.importClause;

    if (!clause) {
      return bindings;
    }

    if (clause.name) {
      bindings.push(clause.name.getText());
    }

    const namedBindings = clause.namedBindings;
    if (!namedBindings) {
      return bindings;
    }

    if (namedBindings.kind === SyntaxKind.NamespaceImport) {
      bindings.push(namedBindings.name.getText());
      return bindings;
    }

    for (const element of namedBindings.elements) {
      bindings.push(element.name.getText());
    }

    return bindings;
  }

  /**
   * 统一提取错误消息，避免日志分支里散落重复的类型判断。
   */
  private static getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
