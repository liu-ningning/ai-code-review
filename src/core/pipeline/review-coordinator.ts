/**
 * 协调 review 任务的排队与串行执行。
 *
 * 当前版本只保留单进程内存调度。
 */
import { logger } from '../../shared/logger.js';
import { getErrorMessage } from '../../shared/error-utils.js';

export interface ReviewTask {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

interface ReviewCoordinatorOptions {
  executor: (task: ReviewTask) => Promise<void>;
}

export class ReviewCoordinator {
  private readonly activeReviews = new Set<string>();
  private readonly pendingReviewHeads = new Map<string, string>();
  private readonly exclusiveExecutions = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ReviewCoordinatorOptions) {}

  async initialize(): Promise<void> {
    logger.info('Review coordinator is using in-memory scheduling.');
  }

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

        if (this.pendingReviewHeads.has(reviewKey)) {
          this.schedule({ ...task, headSha: this.pendingReviewHeads.get(reviewKey)! });
        }
      }
    });
  }

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

  private buildReviewKey(task: ReviewTask): string {
    return `${task.owner}/${task.repo}#${task.prNumber}`;
  }
}
