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

/**
 * 为未来静态分析能力扩展预留的调用参数。
 */
interface StaticAnalysisOptions {
  strategiesByPath?: Map<string, unknown>;
}

/**
 * 依赖注入位点。
 *
 * 当前最小实现虽然尚未真正使用这些依赖，但保留它们能让 pipeline 调用层保持稳定。
 */
interface StaticReviewAnalyzerDependencies {
  createImportResolver?: (checkoutRoot: string, cacheScope: string) => unknown;
}

/**
 * review 主链中的静态分析入口。
 *
 * 当前版本被收缩成“稳定接口 + 空实现”的形式：
 * - 下游仍可依赖统一的数据结构
 * - 未来恢复规则时不需要改动 pipeline 契约
 */
export class StaticReviewAnalyzer {
  constructor(private readonly _dependencies: StaticReviewAnalyzerDependencies = {}) {}

  /**
   * 为每个 diff 预先建立 findings / signals 容器。
   *
   * 这样后续读取 `map.get(path)` 时不会遇到“整个路径从未初始化”的歧义。
   */
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
