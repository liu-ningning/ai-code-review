/**
 * 协调 review 任务的排队与串行执行。
 *
 * 当前版本只保留单进程内存调度。
 */
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/error-utils.js';

/**
 * 表示一个等待进入 review 队列的 MR 任务。
 *
 * 同一个 MR 在短时间内可能连续收到多个新提交，
 * coordinator 会利用 `headSha` 判断“最新应该评审到哪里”。
 */
export interface ReviewTask {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * coordinator 自己不负责真正的 review，只负责串行化与调度。
 */
interface ReviewCoordinatorOptions {
  executor: (task: ReviewTask) => Promise<void>;
}

/**
 * 提供两种互斥能力：
 *
 * - `schedule`：面向异步 webhook 任务，按 MR 维度做“覆盖式排队”
 * - `runExclusive`：面向同步接口，按 key 严格串行执行
 */
export class ReviewCoordinator {
  // 当前正在消费中的 review key。
  private readonly activeReviews = new Set<string>();
  // 同一个 review key 最近一次等待执行的 head sha。
  private readonly pendingReviewHeads = new Map<string, string>();
  // runExclusive 使用的 promise 链尾，保证同 key 顺序执行。
  private readonly exclusiveExecutions = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ReviewCoordinatorOptions) {}

  async initialize(): Promise<void> {
    logger.info('Review coordinator is using in-memory scheduling.');
  }

  /**
   * 把一个 MR review 任务放入内存队列。
   *
   * 这里不是“追加多个任务”，而是对同一个 MR 做覆盖式合并：
   * 只保留最近一次 headSha，确保最终总会 review 到最新提交。
   */
  schedule(task: ReviewTask): void {
    const reviewKey = this.buildReviewKey(task);
    this.pendingReviewHeads.set(reviewKey, task.headSha);

    if (this.activeReviews.has(reviewKey)) {
      logger.info(`Queued follow-up review for ${reviewKey} at ${task.headSha}`);
      return;
    }

    this.activeReviews.add(reviewKey);

    setImmediate(async () => {
      try {
        // 只要这个 MR 还有“待处理的最新 head”，就继续下一轮。
        while (this.pendingReviewHeads.has(reviewKey)) {
          const nextHeadSha = this.pendingReviewHeads.get(reviewKey)!;
          logger.info(`Starting review for ${reviewKey} at ${nextHeadSha}`);
          await this.options.executor({ ...task, headSha: nextHeadSha });

          if (this.pendingReviewHeads.get(reviewKey) === nextHeadSha) {
            this.pendingReviewHeads.delete(reviewKey);
          }

          logger.info(`Full Review Cycle completed for ${reviewKey} at ${nextHeadSha}`);
        }
      } catch (error: unknown) {
        logger.error(`Pipeline execution failed for ${reviewKey}: ${getErrorMessage(error)}`, error);
      } finally {
        this.activeReviews.delete(reviewKey);

        // 执行结束时如果又收到了新 head，则重新拉起下一轮消费。
        if (this.pendingReviewHeads.has(reviewKey)) {
          this.schedule({ ...task, headSha: this.pendingReviewHeads.get(reviewKey)! });
        }
      }
    });
  }

  /**
   * 对给定逻辑 key 执行严格串行。
   *
   * 和 `schedule` 不同，这里不做 head 覆盖或任务折叠，
   * 只保证“前一个没跑完，后一个必须等待”。
   */
  async runExclusive<T>(reviewKey: string, executor: () => Promise<T>): Promise<T> {
    const previousExecution = this.exclusiveExecutions.get(reviewKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentExecution = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const currentChain = previousExecution
      .catch(() => undefined)
      .then(() => currentExecution);
    this.exclusiveExecutions.set(reviewKey, currentChain);

    await previousExecution.catch(() => undefined);

    try {
      return await executor();
    } finally {
      releaseCurrent();

      if (this.exclusiveExecutions.get(reviewKey) === currentChain) {
        this.exclusiveExecutions.delete(reviewKey);
      }
    }
  }

  /**
   * 生成 MR 维度的稳定 key。
   *
   * 这里故意不带 headSha，因为同一个 MR 的连续更新应该复用同一个槽位。
   */
  private buildReviewKey(task: ReviewTask): string {
    return `${task.owner}/${task.repo}#${task.prNumber}`;
  }
}
