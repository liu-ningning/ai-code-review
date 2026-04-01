/**
 * 提供基于 diff 本身的变更影响分析能力。
 *
 * 这个分析器不依赖 AST 或静态规则，而是直接扫描新增/删除内容，
 * 在“删除鉴权、事务、过滤条件、防御性分支”这类高风险改动上补一层确定性信号。
 */
import { FileDiff, ReviewSignal } from '../../types/index.js';
import { collectChangedLines, getChangedNewLineAnchors, getRemovedOldLineEntries } from './diff-utils.js';

/**
 * 从 diff 形态中提炼跨文件影响、迁移风险和 review 提示信号。
 */
export class DiffImpactAnalyzer {
  /**
   * 从 diff 中提取少量高信号的“变更影响”提示。
   */
  static analyze(diff: FileDiff): ReviewSignal[] {
    const removedEntries = getRemovedOldLineEntries(diff);
    const { added, removed } = collectChangedLines(diff);
    const anchorLine = getChangedNewLineAnchors(diff)[0];
    const normalizedRemovedText = removedEntries.map((entry) => entry.text.trim()).filter(Boolean);
    const signals: ReviewSignal[] = [];

    const addSignal = (summary: string) => {
      if (signals.some((signal) => signal.summary === summary)) {
        return;
      }

      signals.push({
        source: 'diff-impact',
        summary,
        line: anchorLine,
      });
    };

    if (removed.length > 0 && added.length === 0) {
      addSignal('本次改动是纯删除/收缩型变更，建议重点确认是否移除了必要的校验、兜底或副作用逻辑。');
    }

    if (normalizedRemovedText.some((line) => /(auth|admin|permission|role|session|token|csrf|signature|verify|tenant)/i.test(line))) {
      addSignal('本次改动删除了鉴权、权限或租户隔离相关逻辑，建议确认不会放宽访问边界。');
    }

    if (normalizedRemovedText.some((line) => /(transaction|begintransaction|commit|rollback|mutex|lock|for update|version|compareandset|cas)/i.test(line))) {
      addSignal('本次改动删除了事务、锁或版本控制相关逻辑，建议确认并发场景下仍然安全。');
    }

    if (normalizedRemovedText.some((line) => /\b(where|tenant_id|user_id|owner_id|status|deleted_at|is_deleted|limit)\b/i.test(line))) {
      addSignal('本次改动删除了查询过滤条件或范围约束，建议确认不会放宽数据读取范围。');
    }

    if (normalizedRemovedText.some((line) => /^\s*(if|throw|return|continue|break|assert|invariant)\b/.test(line))) {
      addSignal('本次改动删除了防御性分支或提前返回逻辑，建议确认异常路径和边界条件仍被覆盖。');
    }

    return signals.slice(0, 3);
  }
}
