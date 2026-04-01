/**
 * 提供一个轻量的异步并发闸门，用于限制某类任务的同时执行数。
 */
export class AsyncConcurrencyGate {
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  /**
   * 在并发闸门保护下执行一个异步任务。
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.maxConcurrency <= 1) {
      if (this.activeCount === 0) {
        this.activeCount = 1;
        return;
      }

      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
      this.activeCount = 1;
      return;
    }

    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
    this.activeCount += 1;
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waitQueue.shift();
    next?.();
  }
}
