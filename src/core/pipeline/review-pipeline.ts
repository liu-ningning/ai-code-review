/**
 * 编排一次完整的 AI review 执行流程。
 *
 * 这个文件把元数据获取、diff 过滤、规模评估、仓库检出、静态分析、
 * RAG 上下文提取、LLM 评审、评论回写和状态更新串成一个完整 pipeline。
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  FileDiff,
  ISCMProvider,
  ReviewComment,
  ReviewSignal,
  ReviewScale,
  PullRequestMetadata,
  CodeContext,
  CodeContextSnippet,
  ReviewCheckRun,
  ReviewCheckConclusion,
  ReviewCheckRunUpdatePayload,
  ReviewCommentSyncResult,
  ReviewProgressEvent,
  ReviewRunResult,
  ReviewTarget,
} from '../../types/index.js';
import { ScaleDetector } from '../scale/scale-detector.js';
import { DiffFilter } from './diff-filter.js';
import { RAGEngine } from '../../rag/rag-engine.js';
import { OpenAIProvider } from '../../providers/llm/openai.provider.js';
import { PromptBuilder } from '../review/prompt-builder.js';
import { logger } from '../../shared/logger.js';
import { config } from '../../config/index.js';
import { RepositoryCheckout, RepositoryCheckoutManager } from '../review/repository-checkout.js';
import { DiffImpactAnalyzer } from '../review/diff-impact-analyzer.js';
import { ReviewFileStrategy, resolveReviewFileStrategy } from '../review/file-review-strategy.js';
import { getChangedNewLineAnchors } from '../review/diff-utils.js';
import { StaticAnalysisResult, StaticReviewAnalyzer } from '../review/static-review-analyzer.js';
import { CodeAnalyzer } from '../../rag/extractor/code-analyzer.js';
import { MultiFileContractAnalyzer } from '../review/multi-file-contract-analyzer.js';
import { getErrorMessage } from '../../shared/error-utils.js';
import { AsyncConcurrencyGate } from '../../shared/async-concurrency-gate.js';

interface ReviewPipelineOptions {
  onProgress?: (event: ReviewProgressEvent) => void | Promise<void>;
}

/**
 * 串联 checkout、静态分析、RAG、LLM 和评论回写的 review 主流程。
 */
export class ReviewPipeline {
  private static readonly REVIEW_STATUS_NAME = 'AI Review';
  private scaleDetector = new ScaleDetector();
  private llmProvider: OpenAIProvider;
  private checkoutManager = new RepositoryCheckoutManager();
  private contractAnalyzer: MultiFileContractAnalyzer;

  /**
   * 创建 review pipeline，并注入 SCM 访问器和可选的进度回调。
   */
  constructor(
    private scmProvider: ISCMProvider,
    private readonly options: ReviewPipelineOptions = {}
  ) {
    this.llmProvider = new OpenAIProvider(
      config.OPENAI_API_KEY || '',
      config.OPENAI_MODEL,
      config.LLM_BASE_URL,
      {
        timeoutMs: config.LLM_TIMEOUT_MS,
        maxRetries: config.LLM_MAX_RETRIES,
        retryBaseDelayMs: config.LLM_RETRY_BASE_DELAY_MS,
      }
    );
    this.contractAnalyzer = new MultiFileContractAnalyzer(this.scmProvider);
  }

  /**
   * 执行一次完整 review，返回最终评论、结论与统计信息。
   */
  async run(target: ReviewTarget): Promise<ReviewRunResult> {
    const { owner, repo } = target;
    const targetLabel =
      target.kind === 'merge_request' ? `MR !${target.number}` : `commit ${target.branch}@${target.headSha.slice(0, 8)}`;

    logger.info(`Starting review pipeline for ${targetLabel} in ${owner}/${repo}`);
    await this.emitProgress('started', `Starting review pipeline for ${targetLabel}`, {
      owner,
      repo,
      targetKind: target.kind,
      targetLabel,
    });

    let prMetadata: PullRequestMetadata | null = null;
    let reviewStatus: ReviewCheckRun | null = null;
    let repositoryCheckout: RepositoryCheckout | null = null;
    let staticAnalysis: StaticAnalysisResult = {
      findingsByPath: new Map(),
      signalsByPath: new Map(),
    };
    let commentSync: ReviewCommentSyncResult = {
      attemptedCount: 0,
      postedCount: 0,
      deletedCount: 0,
      outdatedCount: 0,
      failedCount: 0,
    };
    const reviewStartedAt = new Date().toISOString();

    try {
      // 1. 获取评审目标元数据
      prMetadata = await this.scmProvider.getReviewMetadata(target);
      const pr = prMetadata;
      await this.emitProgress('metadata_loaded', `Loaded review metadata for ${pr.displayId}`, {
        displayId: pr.displayId,
        title: pr.title,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
      });
      reviewStatus = await this.createReviewStatus(pr, reviewStartedAt);

      // 2. 获取 Diff
      const rawDiffs = await this.scmProvider.getDiff(target, pr);
      await this.emitProgress('diff_fetched', `Fetched raw diff for ${pr.displayId}`, {
        rawFileCount: rawDiffs.length,
      });
      
      // 3. 过滤无意义 Diff
      const targetDiffs = DiffFilter.filter(rawDiffs);
      const fileStrategies = new Map<string, ReviewFileStrategy>(
        targetDiffs.map((diff) => [diff.path, resolveReviewFileStrategy(diff.path, diff)])
      );
      await this.emitProgress('diff_filtered', `Filtered diff down to ${targetDiffs.length} reviewable files`, {
        rawFileCount: rawDiffs.length,
        reviewableFileCount: targetDiffs.length,
      });

      if (targetDiffs.length === 0) {
        const completedAt = new Date().toISOString();
        await this.updateReviewStatus(pr, reviewStatus, {
          detailsUrl: pr.htmlUrl,
          status: 'completed',
          conclusion: 'neutral',
          startedAt: reviewStartedAt,
          completedAt,
          output: {
            title: 'AI Review skipped',
            summary: this.buildSkippedSummary(rawDiffs.length),
            text: this.buildSkippedText(pr, rawDiffs.length),
          },
        });
        await this.emitProgress('completed', `Review pipeline completed for ${targetLabel}`, {
          conclusion: 'neutral',
          reviewedFileCount: 0,
          commentCount: 0,
          syncedCommentCount: 0,
          deletedCommentCount: 0,
          outdatedCommentCount: 0,
          commentSyncFailureCount: 0,
          errorCount: 0,
        });

        return {
          metadata: pr,
          comments: [],
          conclusion: 'neutral',
          reviewedFileCount: 0,
          errorCount: 0,
          commentSync,
        };
      }
      
      // 4. 检测规模并决定策略
      const { scale, riskScore } = this.scaleDetector.detect(targetDiffs);
      logger.info(`Detected review scale: ${scale}, Risk Score: ${riskScore} (${targetDiffs.length} files to review)`);
      await this.emitProgress('scale_detected', `Detected review scale ${scale}`, {
        scale,
        riskScore,
        reviewableFileCount: targetDiffs.length,
      });

      repositoryCheckout = await this.checkoutManager.checkout(owner, repo, pr.sourceBranch, pr.headSha);
      await this.emitProgress('checkout_prepared', `Prepared repository checkout for ${owner}/${repo}`, {
        checkoutDir: repositoryCheckout.rootDir,
      });
      const staticReviewAnalyzer = new StaticReviewAnalyzer();
      const [baseStaticAnalysis, contractAnalysis, clusterSummariesByPath] = await Promise.all([
        staticReviewAnalyzer.analyze(
          repositoryCheckout.rootDir,
          targetDiffs,
          `${owner}/${repo}:${pr.kind}:${pr.baseSha || ''}:${pr.headSha}`,
          { strategiesByPath: fileStrategies }
        ),
        this.contractAnalyzer.analyze(
          repositoryCheckout.rootDir,
          owner,
          repo,
          targetDiffs,
          pr.baseSha || pr.targetBranch
        ),
        this.buildChangeClusterSummaries(
          repositoryCheckout.rootDir,
          targetDiffs
        ),
      ]);
      staticAnalysis = this.mergeStaticAnalysisResults(
        baseStaticAnalysis,
        contractAnalysis
      );
      await this.emitProgress('static_analysis_completed', 'Completed static analysis for reviewable files', {
        signalCount: this.countEntries(staticAnalysis.signalsByPath),
        findingCount: this.countEntries(staticAnalysis.findingsByPath),
      });

      const ragEngine = new RAGEngine(this.scmProvider, repositoryCheckout.rootDir);
      const fileConcurrency = Math.max(1, Math.min(config.REVIEW_FILE_CONCURRENCY, targetDiffs.length || 1));
      const llmConcurrency = Math.max(1, Math.min(config.LLM_REVIEW_CONCURRENCY, fileConcurrency, targetDiffs.length || 1));
      const llmConcurrencyGate = new AsyncConcurrencyGate(llmConcurrency);
      logger.info(`Reviewing ${targetDiffs.length} files with file concurrency ${fileConcurrency} and LLM concurrency ${llmConcurrency}`);
      await this.emitProgress('review_started', `Reviewing ${targetDiffs.length} files`, {
        reviewableFileCount: targetDiffs.length,
        fileConcurrency,
        llmConcurrency,
      });

      await this.updateReviewStatus(pr, reviewStatus, {
        detailsUrl: prMetadata.htmlUrl,
        status: 'in_progress',
        startedAt: reviewStartedAt,
        output: {
          title: 'AI Review in progress',
          summary: this.buildProgressSummary(scale, riskScore, targetDiffs.length, fileConcurrency, llmConcurrency),
          text: this.buildProgressText(pr, scale, riskScore, targetDiffs),
        },
      });

      const reviewResults: ReviewComment[][] = Array.from({ length: targetDiffs.length }, () => []);
      const reviewErrors: Array<{ path: string; message: string }> = [];
      let nextFileIndex = 0;
      let completedFiles = 0;

      const reviewWorker = async () => {
        while (true) {
          const currentIndex = nextFileIndex++;
          if (currentIndex >= targetDiffs.length) {
            return;
          }

          const fileDiff = targetDiffs[currentIndex];
          try {
            await this.emitProgress('file_review_started', `Reviewing file ${fileDiff.path}`, {
              path: fileDiff.path,
              index: currentIndex + 1,
              total: targetDiffs.length,
              completed: completedFiles,
            });
            reviewResults[currentIndex] = await this.reviewFile(
              owner,
              repo,
              pr,
              fileDiff,
              fileStrategies.get(fileDiff.path) ?? resolveReviewFileStrategy(fileDiff.path, fileDiff),
              scale,
              ragEngine,
              staticAnalysis,
              clusterSummariesByPath,
              llmConcurrencyGate
            );
            completedFiles += 1;
            await this.emitProgress('file_review_completed', `Reviewed file ${fileDiff.path}`, {
              path: fileDiff.path,
              index: currentIndex + 1,
              total: targetDiffs.length,
              completed: completedFiles,
              commentCount: reviewResults[currentIndex].length,
            });
          } catch (error: unknown) {
            const errorMessage = getErrorMessage(error);
            logger.error(`Failed to review file: ${fileDiff.path}`, errorMessage);
            reviewErrors.push({ path: fileDiff.path, message: errorMessage });
            completedFiles += 1;
            await this.emitProgress('file_review_failed', `Failed to review file ${fileDiff.path}`, {
              path: fileDiff.path,
              index: currentIndex + 1,
              total: targetDiffs.length,
              completed: completedFiles,
              error: errorMessage,
            });
          }
        }
      };

      // 5. 逐个文件处理 (Per-file Review)
      await Promise.all(Array.from({ length: fileConcurrency }, () => reviewWorker()));

      const allComments = reviewResults.flat();
      await this.emitProgress('posting_comments', `Syncing ${allComments.length} review comments`, {
        commentCount: allComments.length,
      });
      commentSync = await this.scmProvider.postComments(target, pr, allComments);
      await this.emitProgress('comments_posted', `Synchronized ${commentSync.postedCount} review comments`, {
        commentCount: allComments.length,
        syncedCommentCount: commentSync.postedCount,
        deletedCommentCount: commentSync.deletedCount,
        outdatedCommentCount: commentSync.outdatedCount,
        commentSyncFailureCount: commentSync.failedCount,
      });

      const totalErrorCount = reviewErrors.length + (commentSync.failedCount > 0 ? 1 : 0);
      const reviewConclusion = this.resolveConclusion(targetDiffs.length, totalErrorCount, allComments.length);

      await this.updateReviewStatus(pr, reviewStatus, {
        detailsUrl: pr.htmlUrl,
        status: 'completed',
        conclusion: reviewConclusion,
        startedAt: reviewStartedAt,
        completedAt: new Date().toISOString(),
        output: {
          title: this.buildCompletionTitle(reviewConclusion, commentSync.postedCount, totalErrorCount),
          summary: this.buildCompletionSummary(reviewConclusion, commentSync.postedCount, targetDiffs.length, totalErrorCount, commentSync),
          text: this.buildCompletionText(pr, reviewConclusion, commentSync, targetDiffs.length, reviewErrors),
        },
      });
      await this.emitProgress('completed', `Review pipeline completed for ${targetLabel}`, {
        conclusion: reviewConclusion,
        reviewedFileCount: targetDiffs.length,
        commentCount: allComments.length,
        syncedCommentCount: commentSync.postedCount,
        deletedCommentCount: commentSync.deletedCount,
        outdatedCommentCount: commentSync.outdatedCount,
        commentSyncFailureCount: commentSync.failedCount,
        errorCount: totalErrorCount,
      });

      return {
        metadata: pr,
        comments: allComments,
        conclusion: reviewConclusion,
        reviewedFileCount: targetDiffs.length,
        errorCount: totalErrorCount,
        commentSync,
      };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      logger.error(`Review pipeline failed for ${targetLabel} in ${owner}/${repo}`, errorMessage);
      await this.emitProgress('failed', `Review pipeline failed for ${targetLabel}`, {
        error: errorMessage,
      });

      if (prMetadata) {
        await this.updateReviewStatus(prMetadata, reviewStatus, {
          detailsUrl: prMetadata.htmlUrl,
          status: 'completed',
          conclusion: 'failure',
          startedAt: reviewStartedAt,
          completedAt: new Date().toISOString(),
          output: {
            title: 'AI Review failed',
            summary: `AI review could not finish for ${this.buildReviewLabel(prMetadata)}.`,
            text: this.truncateForCheckText(`错误信息: ${errorMessage}`),
          },
        });
      }

      throw error;
    } finally {
      if (repositoryCheckout) {
        await repositoryCheckout.cleanup();
      }
    }
  }

  /**
   * 对单个文件执行上下文提取、提示词构建和 LLM 评审，并合并静态发现。
   */
  private async reviewFile(
    owner: string,
    repo: string,
    pr: PullRequestMetadata,
    diff: FileDiff,
    strategy: ReviewFileStrategy,
    scale: ReviewScale,
    ragEngine: RAGEngine,
    staticAnalysis: StaticAnalysisResult,
    clusterSummariesByPath: Map<string, CodeContextSnippet[]>,
    llmConcurrencyGate: AsyncConcurrencyGate
  ): Promise<ReviewComment[]> {
    logger.debug(`Reviewing file: ${diff.path}`);

    const reviewSegments = strategy.preferHunkReview
      ? await ragEngine.segmentDiff(owner, repo, diff, pr.headSha, 4)
      : [diff];
    const staticSignals = staticAnalysis.signalsByPath.get(diff.path) ?? [];
    const staticFindings = staticAnalysis.findingsByPath.get(diff.path) ?? [];
    const diffImpactSignals = DiffImpactAnalyzer.analyze(diff);
    const fileSignals = [...staticSignals, ...diffImpactSignals];
    const collectedComments: ReviewComment[] = [];
      let lastSegmentError: unknown = null;

    for (let segmentIndex = 0; segmentIndex < reviewSegments.length; segmentIndex += 1) {
      const segmentDiff = reviewSegments[segmentIndex];
      const segmentSignals = this.filterSignalsForSegment(fileSignals, segmentDiff, segmentIndex, reviewSegments.length);
      const context: CodeContext = await ragEngine.extract(
        owner,
        repo,
        segmentDiff,
        {
          targetRef: pr.headSha,
          baselineRef: pr.baseSha || pr.targetBranch,
          initialSignals: segmentSignals,
          strategy,
        }
      );
      for (const clusterSnippet of clusterSummariesByPath.get(diff.path) ?? []) {
        if (!context.semanticSlices.some((slice) => (
          slice.label === clusterSnippet.label
          && slice.content === clusterSnippet.content
          && slice.file === clusterSnippet.file
        ))) {
          context.semanticSlices.unshift(clusterSnippet);
        }
      }
      logger.debug(`Collected review context for ${diff.path}`, {
        scale,
        strategy: strategy.kind,
        segmentIndex: segmentIndex + 1,
        totalSegments: reviewSegments.length,
        functions: context.functions.length,
        types: context.types.length,
        signals: context.signals.length,
      });

      const prompt = PromptBuilder.build(pr, segmentDiff, context, {
        strategy,
        segmentIndex: reviewSegments.length > 1 ? segmentIndex + 1 : undefined,
        totalSegments: reviewSegments.length > 1 ? reviewSegments.length : undefined,
      });

      try {
        const comments = await llmConcurrencyGate.run(() => this.llmProvider.generateReview(prompt, diff.path));
        collectedComments.push(...comments.map((comment) => ({
          ...comment,
          oldPath: diff.oldPath || comment.oldPath,
        })));
      } catch (error) {
        lastSegmentError = error;
        logger.warn(`LLM review failed for ${diff.path} segment ${segmentIndex + 1}/${reviewSegments.length}, continuing with remaining segments.`);
      }
    }

    if (collectedComments.length === 0) {
      if (staticFindings.length > 0) {
        logger.warn(`LLM review failed for ${diff.path}, returning static findings only.`);
        return staticFindings.map((finding) => ({
          ...finding,
          oldPath: diff.oldPath || finding.oldPath,
        }));
      }

      if (lastSegmentError) {
        throw lastSegmentError;
      }
    }

    return this.mergeStaticFindings(staticFindings, this.deduplicateComments(collectedComments));
  }

  /**
   * 为当前 review 在 SCM 侧创建一条可跟踪的状态检查记录。
   */
  private async createReviewStatus(
    pr: PullRequestMetadata,
    startedAt: string
  ): Promise<ReviewCheckRun | null> {
    if (!this.scmProvider.createReviewStatus) {
      return null;
    }

    return this.scmProvider.createReviewStatus(pr, {
      name: ReviewPipeline.REVIEW_STATUS_NAME,
      headSha: pr.headSha,
      detailsUrl: pr.htmlUrl,
      externalId: `${pr.owner}/${pr.repo}:${pr.displayId}:${pr.headSha}`,
      status: 'queued',
      startedAt,
      output: {
        title: 'AI Review queued',
        summary: `AI review request received for ${this.buildReviewLabel(pr)}. Preparing context and diff analysis.`,
        text: this.truncateForCheckText(
          `评审对象: ${this.buildReviewLabel(pr)}\n目标分支: ${pr.targetBranch}\n源分支: ${pr.sourceBranch}\n作者: ${pr.author}`
        ),
      },
    });
  }

  /**
   * 在 SCM 状态检查已存在时，推送最新的执行状态与摘要信息。
   */
  private async updateReviewStatus(
    metadata: PullRequestMetadata,
    reviewStatus: ReviewCheckRun | null,
    payload: ReviewCheckRunUpdatePayload
  ): Promise<void> {
    if (!reviewStatus || !this.scmProvider.updateReviewStatus) {
      return;
    }

    await this.scmProvider.updateReviewStatus(metadata, reviewStatus, payload);
  }

  /**
   * 生成 review 进行中的简短状态摘要。
   */
  private buildProgressSummary(
    scale: ReviewScale,
    riskScore: number,
    fileCount: number,
    fileConcurrency: number,
    llmConcurrency: number
  ): string {
    return `正在分析 ${fileCount} 个文件，规模 ${scale}，风险分 ${riskScore}，文件并发 ${fileConcurrency}，LLM 并发 ${llmConcurrency}。`;
  }

  /**
   * 生成 review 进行中的详细状态文本，供检查运行详情展示。
   */
  private buildProgressText(
    pr: PullRequestMetadata,
    scale: ReviewScale,
    riskScore: number,
    targetDiffs: FileDiff[]
  ): string {
    const previewFiles = targetDiffs.slice(0, 12).map((diff) => `- ${diff.path}`).join('\n');
    return this.truncateForCheckText(
      `${this.buildReviewLabel(pr)}: ${pr.title}\n作者: ${pr.author}\n分支: ${pr.sourceBranch} -> ${pr.targetBranch}\n规模: ${scale}\n风险分: ${riskScore}\n\n文件预览:\n${previewFiles}${targetDiffs.length > 12 ? `\n- ... 另有 ${targetDiffs.length - 12} 个文件` : ''}`
    );
  }

  /**
   * 生成“无可评审文件”场景下的简短状态摘要。
   */
  private buildSkippedSummary(rawFileCount: number): string {
    return `AI review 已跳过：共拿到 ${rawFileCount} 个变更文件，但过滤后没有高信号文件进入 review 主链。`;
  }

  /**
   * 生成“无可评审文件”场景下的详细状态文本。
   */
  private buildSkippedText(pr: PullRequestMetadata, rawFileCount: number): string {
    return this.truncateForCheckText(
      `${this.buildReviewLabel(pr)} review skipped.\n原始变更文件数: ${rawFileCount}\n进入 review 主链的文件数: 0\n原因: 当前 diff 仅包含被过滤的低信号文件，例如锁文件、构建产物、图片或普通文档改动。`
    );
  }

  /**
   * 根据执行结果生成最终状态标题。
   */
  private buildCompletionTitle(
    conclusion: ReviewCheckConclusion,
    commentCount: number,
    errorCount: number
  ): string {
    if (errorCount > 0) {
      return 'AI Review completed with errors';
    }

    if (conclusion === 'failure' && commentCount > 0) {
      return 'AI Review found blocking issues';
    }

    if (conclusion === 'neutral') {
      return 'AI Review skipped';
    }

    return 'AI Review completed';
  }

  /**
   * 在配置了回调时向外部推送一条 review 进度事件。
   */
  private async emitProgress(
    stage: ReviewProgressEvent['stage'],
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    if (!this.options.onProgress) {
      return;
    }

    await this.options.onProgress({
      stage,
      message,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  /**
   * 统计 map 中所有数组项的总数量。
   */
  private countEntries<T>(map: Map<string, T[]>): number {
    let total = 0;
    for (const values of map.values()) {
      total += values.length;
    }
    return total;
  }

  /**
   * 把多来源静态分析结果聚合成一份统一结果，避免后续阶段感知来源差异。
   */
  private mergeStaticAnalysisResults(...results: StaticAnalysisResult[]): StaticAnalysisResult {
    const findingsByPath = new Map<string, StaticAnalysisResult['findingsByPath'] extends Map<string, infer T> ? T : never>();
    const signalsByPath = new Map<string, StaticAnalysisResult['signalsByPath'] extends Map<string, infer T> ? T : never>();

    for (const result of results) {
      for (const [filePath, findings] of result.findingsByPath.entries()) {
        const bucket = findingsByPath.get(filePath) ?? [];
        bucket.push(...findings);
        findingsByPath.set(filePath, bucket);
      }

      for (const [filePath, signals] of result.signalsByPath.entries()) {
        const bucket = signalsByPath.get(filePath) ?? [];
        bucket.push(...signals);
        signalsByPath.set(filePath, bucket);
      }
    }

    return {
      findingsByPath,
      signalsByPath,
    };
  }

  /**
   * 生成 review 完成后的摘要描述。
   */
  private buildCompletionSummary(
    conclusion: ReviewCheckConclusion,
    commentCount: number,
    fileCount: number,
    errorCount: number,
    commentSync: ReviewCommentSyncResult
  ): string {
    if (commentSync.failedCount > 0) {
      return `AI review 执行失败，评论同步发布 ${commentSync.postedCount} 条、清理 ${commentSync.deletedCount} 条、标记过期 ${commentSync.outdatedCount} 条，另有 ${commentSync.failedCount} 条同步失败。`;
    }

    if (errorCount > 0) {
      return `AI review 执行失败，分析了 ${fileCount} 个文件，其中 ${errorCount} 个文件处理失败，请查看日志。`;
    }

    if (conclusion === 'failure' && commentCount > 0) {
      return `AI review 未通过，分析了 ${fileCount} 个文件，并发布了 ${commentCount} 条阻断评论。`;
    }

    if (conclusion === 'neutral' && fileCount === 0) {
      return 'AI review 已跳过，过滤后没有高信号文件进入 review 主链。';
    }

    if (commentCount > 0) {
      return `AI review 已完成，分析了 ${fileCount} 个文件，并发布了 ${commentCount} 条 review 评论。`;
    }

    return `AI review 已通过，分析了 ${fileCount} 个文件，未发现需要发布的高信号评论。`;
  }

  /**
   * 生成 review 完成后的详细文本，包含失败文件或评论数量概览。
   */
  private buildCompletionText(
    pr: PullRequestMetadata,
    conclusion: ReviewCheckConclusion,
    commentSync: ReviewCommentSyncResult,
    fileCount: number,
    reviewErrors: Array<{ path: string; message: string }>
  ): string {
    if (commentSync.failedCount > 0) {
      return this.truncateForCheckText(
        `${this.buildReviewLabel(pr)} review completed with comment sync failures.\n分析文件数: ${fileCount}\n尝试评论数: ${commentSync.attemptedCount}\n已发布评论数: ${commentSync.postedCount}\n已删除旧评论数: ${commentSync.deletedCount}\n已标记过期评论数: ${commentSync.outdatedCount}\n评论同步失败数: ${commentSync.failedCount}`
      );
    }

    if (reviewErrors.length === 0) {
      const resultLine =
        conclusion === 'failure' && commentSync.postedCount > 0
          ? 'Review 结果: 未通过'
          : conclusion === 'success'
            ? 'Review 结果: 通过'
            : conclusion === 'neutral' && fileCount === 0
              ? 'Review 结果: 已跳过'
            : 'Review 结果: 已完成';

      return this.truncateForCheckText(
        `${this.buildReviewLabel(pr)} review completed.\n${resultLine}\n分析文件数: ${fileCount}\n发布评论数: ${commentSync.postedCount}\n删除旧评论数: ${commentSync.deletedCount}\n标记过期评论数: ${commentSync.outdatedCount}`
      );
    }

    const previewErrors = reviewErrors
      .slice(0, 8)
      .map((item) => `- ${item.path}: ${item.message}`)
      .join('\n');

    return this.truncateForCheckText(
      `${this.buildReviewLabel(pr)} review completed with partial failures.\n分析文件数: ${fileCount}\n发布评论数: ${commentSync.postedCount}\n删除旧评论数: ${commentSync.deletedCount}\n标记过期评论数: ${commentSync.outdatedCount}\n失败文件数: ${reviewErrors.length}\n\n失败详情:\n${previewErrors}${reviewErrors.length > 8 ? `\n- ... 另有 ${reviewErrors.length - 8} 个文件失败` : ''}`
    );
  }

  /**
   * 根据文件数、错误数和评论数决定最终 review 结论。
   */
  private resolveConclusion(fileCount: number, errorCount: number, commentCount: number): ReviewCheckConclusion {
    if (errorCount > 0) {
      return 'failure';
    }

    if (config.REVIEW_FAIL_ON_COMMENTS && commentCount > 0) {
      return 'failure';
    }

    if (fileCount === 0) {
      return 'neutral';
    }

    return 'success';
  }

  /**
   * 截断状态详情文本，避免超出 SCM 检查运行的文本长度限制。
   */
  private truncateForCheckText(text: string, maxLength = 60000): string {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 16).trimEnd()}\n... truncated`;
  }

  /**
   * 生成统一的 review 对象标签，兼容 Merge Request 和 commit 两种模式。
   */
  private buildReviewLabel(metadata: PullRequestMetadata): string {
    return metadata.kind === 'merge_request' ? `MR ${metadata.displayId}` : `Commit ${metadata.displayId}`;
  }

  /**
   * 合并静态分析结果与 LLM 评论，并按路径/行号/边去重。
   */
  private mergeStaticFindings(
    staticFindings: Array<{ line: number; side: 'LEFT' | 'RIGHT' } & ReviewComment>,
    llmComments: ReviewComment[]
  ): ReviewComment[] {
    if (staticFindings.length === 0) {
      return llmComments;
    }

    const llmLineKeys = new Set(llmComments.map((comment) => `${comment.path}:${comment.line}:${comment.side}`));
    const remainingStaticFindings = staticFindings.filter((finding) => (
      !llmLineKeys.has(`${finding.path}:${finding.line}:${finding.side}`)
    ));

    return [...remainingStaticFindings, ...llmComments];
  }

  /**
   * 只把与当前 segment 直接相关的信号带入提示词，减少多 hunk 文件的上下文串味。
   */
  private filterSignalsForSegment(
    signals: ReviewSignal[],
    segmentDiff: FileDiff,
    segmentIndex: number,
    totalSegments: number
  ): ReviewSignal[] {
    const segmentAnchors = new Set(getChangedNewLineAnchors(segmentDiff));

    return signals.filter((signal) => {
      if (!signal.line) {
        return totalSegments === 1 || segmentIndex === 0;
      }

      return segmentAnchors.has(signal.line);
    });
  }

  /**
   * 对多段 hunk 评审产生的评论做去重，避免同一问题被重复回写。
   */
  private deduplicateComments(comments: ReviewComment[]): ReviewComment[] {
    const seen = new Set<string>();
    const deduplicated: ReviewComment[] = [];

    for (const comment of comments) {
      const normalizedBody = comment.body.replace(/^Token 消耗:[^\n]*\n\n/, '').trim();
      const key = `${comment.path}:${comment.line}:${comment.side}:${normalizedBody}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduplicated.push(comment);
    }

    return deduplicated;
  }

  /**
   * 为多文件协同改动构建簇级摘要，帮助单文件 prompt 感知“这不是孤立改动”。
   */
  private async buildChangeClusterSummaries(
    checkoutRoot: string,
    diffs: FileDiff[]
  ): Promise<Map<string, CodeContextSnippet[]>> {
    if (diffs.length <= 1) {
      return new Map();
    }

    const codeAnalyzer = new CodeAnalyzer();
    const descriptors = await Promise.all(diffs.map(async (diff) => {
      const normalizedPath = diff.path.replace(/\\/g, '/');
      const pathTokens = normalizedPath
        .split('/')
        .flatMap((segment) => segment.replace(/\.[^.]+$/, '').split(/[-_.]/))
        .filter((segment) => segment.length >= 3)
        .map((segment) => segment.toLowerCase());
      const symbolTokens = new Set<string>();

      try {
        const absolutePath = path.join(checkoutRoot, normalizedPath);
        const content = await readFile(absolutePath, 'utf8');
        const diffAnalysis = await codeAnalyzer.analyzeFileDiff(normalizedPath, content, diff);
        for (const symbol of diffAnalysis.localSymbols) {
          symbolTokens.add(symbol.name);
        }
        for (const candidate of diffAnalysis.identifiers.slice(0, 6)) {
          symbolTokens.add(candidate.name);
        }
      } catch {
        // ignore files that cannot be parsed from checkout
      }

      return {
        path: normalizedPath,
        directory: path.posix.dirname(normalizedPath),
        pathTokens: new Set(pathTokens),
        symbolTokens,
      };
    }));

    const adjacency = new Map<string, Set<string>>();
    for (const descriptor of descriptors) {
      adjacency.set(descriptor.path, new Set());
    }

    for (let leftIndex = 0; leftIndex < descriptors.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < descriptors.length; rightIndex += 1) {
        const left = descriptors[leftIndex];
        const right = descriptors[rightIndex];
        const sharedSymbols = this.countSetOverlap(left.symbolTokens, right.symbolTokens);
        const sharedPathTokens = this.countSetOverlap(left.pathTokens, right.pathTokens);
        const nearbyDirectory = left.directory === right.directory
          || left.directory === path.posix.dirname(right.directory)
          || right.directory === path.posix.dirname(left.directory);

        if (sharedSymbols >= 2 || (sharedSymbols >= 1 && nearbyDirectory) || sharedPathTokens >= 2) {
          adjacency.get(left.path)?.add(right.path);
          adjacency.get(right.path)?.add(left.path);
        }
      }
    }

    const visited = new Set<string>();
    const summariesByPath = new Map<string, CodeContextSnippet[]>();

    for (const descriptor of descriptors) {
      if (visited.has(descriptor.path)) {
        continue;
      }

      const queue = [descriptor.path];
      const cluster: string[] = [];
      while (queue.length > 0) {
        const currentPath = queue.shift()!;
        if (visited.has(currentPath)) {
          continue;
        }

        visited.add(currentPath);
        cluster.push(currentPath);
        for (const neighbor of adjacency.get(currentPath) ?? []) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }

      if (cluster.length <= 1) {
        continue;
      }

      const clusterDescriptors = descriptors.filter((item) => cluster.includes(item.path));
      const sharedSymbols = this.getTopSharedItems(clusterDescriptors.map((item) => item.symbolTokens), 6);
      const summary = [
        '这批改动很可能属于同一组协同重构或接口同步修改。',
        '相关文件:',
        ...cluster.map((clusterPath) => `- ${clusterPath}`),
        sharedSymbols.length > 0 ? `共享符号: ${sharedSymbols.join(', ')}` : '共享符号: （未稳定提取到）',
        '评审时要重点检查接口契约、调用方、类型定义和运行时分支是否一起完成迁移。',
      ].join('\n');

      for (const clusterPath of cluster) {
        summariesByPath.set(clusterPath, [{
          label: '相关改动簇',
          file: clusterPath,
          content: summary,
        }]);
      }
    }

    return summariesByPath;
  }

  /**
   * 统计两个集合的交集大小。
   */
  private countSetOverlap(left: Set<string>, right: Set<string>): number {
    let count = 0;
    for (const item of left) {
      if (right.has(item)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 从多个集合中提取最常重复出现的若干项，用于描述改动簇的共享符号。
   */
  private getTopSharedItems(sets: Set<string>[], maxItems: number): string[] {
    const counts = new Map<string, number>();
    for (const currentSet of sets) {
      for (const item of currentSet) {
        counts.set(item, (counts.get(item) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, maxItems)
      .map(([item]) => item);
  }
}
