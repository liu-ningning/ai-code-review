/**
 * 提供 review 前置的轻量静态分析能力。
 *
 * 当前版本已移除外部存储相关规则，只保留统一的数据结构与
 * 最小实现，供主流程继续拼装 prompt。
 */
import { FileDiff, ReviewSignal, StaticReviewFinding } from '../../types/index.js';

export interface StaticAnalysisResult {
  findingsByPath: Map<string, StaticReviewFinding[]>;
  signalsByPath: Map<string, ReviewSignal[]>;
}

interface StaticAnalysisOptions {
  strategiesByPath?: Map<string, unknown>;
}

interface StaticReviewAnalyzerDependencies {
  createImportResolver?: (checkoutRoot: string, cacheScope: string) => unknown;
}

export class StaticReviewAnalyzer {
  constructor(private readonly _dependencies: StaticReviewAnalyzerDependencies = {}) {}

  async analyze(
    _checkoutRoot: string,
    diffs: FileDiff[],
    _cacheScope: string,
    _options: StaticAnalysisOptions = {}
  ): Promise<StaticAnalysisResult> {
    const findingsByPath = new Map<string, StaticReviewFinding[]>();
    const signalsByPath = new Map<string, ReviewSignal[]>();

    for (const diff of diffs) {
      findingsByPath.set(diff.path, []);
      signalsByPath.set(diff.path, []);
    }

    return {
      findingsByPath,
      signalsByPath,
    };
  }
}
