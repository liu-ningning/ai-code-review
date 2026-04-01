/**
 * 根据 diff 规模和高风险路径判断本次 review 的处理级别。
 *
 * 这个文件负责估算变更体量与风险分，供后续 pipeline 选择评审策略、
 * 状态文案和并发参数。
 */
import { FileDiff, ReviewScale } from '../../types/index.js';
import { collectChangedLines } from '../review/diff-utils.js';
import { DiffImpactAnalyzer } from '../review/diff-impact-analyzer.js';
import { resolveReviewFileStrategy } from '../review/file-review-strategy.js';

/**
 * 定义 diff 规模分档时使用的阈值配置。
 */
export interface ScaleConfig {
  maxLinesForSmall: number;
  maxLinesForMedium: number;
}

/**
 * 根据变更行数和影响信号判断本次 review 的规模等级。
 */
export class ScaleDetector {
  private config: ScaleConfig = {
    maxLinesForSmall: 100,
    maxLinesForMedium: 500,
  };

  // 少量“命中即提高风险分”的路径，不追求穷尽所有场景。
  private static readonly HIGH_RISK_PATHS = [
    /src\/auth\//,
    /src\/security\//,
    /src\/config\//,
    /\.env/,
  ];

  /**
   * 根据文件数、变更行数和高风险路径命中情况计算 review 规模与风险分。
   *
   * 这个评估不是简单按行数分桶，还会叠加：
   * - 删除型改动带来的回归风险
   * - diff-impact 的启发式高风险信号
   * - 文件策略类别本身的业务敏感度
   * - 特殊高风险目录命中
   */
  detect(diffs: FileDiff[]): { scale: ReviewScale; riskScore: number } {
    let riskScore = 0;

    const totalLines = diffs.reduce((acc, diff) => {
      const isHighRisk = ScaleDetector.HIGH_RISK_PATHS.some(pattern => pattern.test(diff.path));
      const { added, removed } = collectChangedLines(diff);
      const changedLines = added.length + removed.length;
      const strategy = resolveReviewFileStrategy(diff.path, diff);
      const diffImpactSignals = DiffImpactAnalyzer.analyze(diff);

      if (isHighRisk) {
        riskScore += 10;
      }

      riskScore += Math.ceil(changedLines / 12);
      riskScore += Math.ceil(removed.length / 10);
      riskScore += diffImpactSignals.length * 6;

      if (diff.status === 'deleted' || (removed.length > 0 && added.length === 0)) {
        riskScore += 6;
      }

      // 某些文件类型天然更值得收紧 review 等级。
      switch (strategy.kind) {
        case 'backend_service':
        case 'ci_pipeline':
          riskScore += 8;
          break;
        case 'app_config':
          riskScore += 10;
          break;
        case 'react_component':
          riskScore += 4;
          break;
        default:
          break;
      }

      return acc + changedLines;
    }, 0);

    const fileCount = diffs.length;
    let scale: ReviewScale = 'LARGE';

    // 先按体量给出基础分档。
    if (totalLines <= this.config.maxLinesForSmall && fileCount <= 5) {
      scale = 'SMALL';
    } else if (totalLines <= this.config.maxLinesForMedium && fileCount <= 20) {
      scale = 'MEDIUM';
    }

    // 如果风险较高，即便代码量少也强制升级为更高档位。
    if (riskScore > 50 && scale === 'SMALL') {
      scale = 'MEDIUM';
    }

    if (riskScore > 90 && scale !== 'LARGE') {
      scale = 'LARGE';
    }

    return { scale, riskScore };
  }
}
