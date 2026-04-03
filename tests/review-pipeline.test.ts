/**
 * 验证完整 review pipeline 的阶段衔接和结果汇总行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewPipeline } from '../src/core/pipeline/review-pipeline.js';
import { config } from '../src/config/index.js';
import type {
  FileDiff,
  ISCMProvider,
  PullRequestMetadata,
  ReviewCheckRun,
  ReviewCheckRunPayload,
  ReviewCheckRunUpdatePayload,
  ReviewComment,
  ReviewCommentSyncOptions,
  ReviewCommentSyncResult,
  ReviewTarget,
} from '../src/types/index.js';

test('skips checkout and comment sync when diff filtering leaves no reviewable files', async () => {
  let postCommentsCalls = 0;
  let createStatusCalls = 0;
  const statusUpdates: ReviewCheckRunUpdatePayload[] = [];

  const metadata: PullRequestMetadata = {
    id: 'mr-1',
    title: 'Update lockfile only',
    description: '',
    htmlUrl: 'https://example.com/mr/1',
    owner: 'owner',
    repo: 'repo',
    sourceBranch: 'feature',
    headSha: 'head-sha',
    targetBranch: 'main',
    author: 'tester',
    kind: 'merge_request',
    displayId: '!1',
    baseSha: 'base-sha',
  };
  const emptySync: ReviewCommentSyncResult = {
    attemptedCount: 0,
    postedCount: 0,
    deletedCount: 0,
    outdatedCount: 0,
    failedCount: 0,
  };

  const provider: ISCMProvider = {
    async getReviewMetadata(_target: ReviewTarget): Promise<PullRequestMetadata> {
      return metadata;
    },
    async getDiff(_target: ReviewTarget, _loadedMetadata: PullRequestMetadata): Promise<FileDiff[]> {
      return [{
        path: 'pnpm-lock.yaml',
        status: 'modified',
        chunks: [
          {
            content: '@@ -1,1 +1,1 @@\n-lock-old\n+lock-new',
            oldRange: { start: 1, lines: 1 },
            newRange: { start: 1, lines: 1 },
          },
        ],
      }];
    },
    async postComments(
      _target: ReviewTarget,
      _loadedMetadata: PullRequestMetadata,
      _comments: ReviewComment[],
      _options?: ReviewCommentSyncOptions
    ): Promise<ReviewCommentSyncResult> {
      postCommentsCalls += 1;
      return emptySync;
    },
    async getFileContent(): Promise<string> {
      throw new Error('getFileContent should not be called when review is skipped');
    },
    async searchCode(): Promise<string[]> {
      return [];
    },
    async createReviewStatus(
      _loadedMetadata: PullRequestMetadata,
      _payload: ReviewCheckRunPayload
    ): Promise<ReviewCheckRun | null> {
      createStatusCalls += 1;
      return { id: 1, name: 'AI Review' };
    },
    async updateReviewStatus(
      _loadedMetadata: PullRequestMetadata,
      _checkRun: ReviewCheckRun,
      payload: ReviewCheckRunUpdatePayload
    ): Promise<void> {
      statusUpdates.push(payload);
    },
  };

  const result = await new ReviewPipeline(provider).run({
    kind: 'merge_request',
    owner: 'owner',
    repo: 'repo',
    number: 1,
  });

  assert.equal(result.conclusion, 'neutral');
  assert.equal(result.reviewedFileCount, 0);
  assert.equal(result.comments.length, 0);
  assert.equal(postCommentsCalls, 0);
  assert.equal(createStatusCalls, 1);
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0]?.conclusion, 'neutral');
  assert.match(statusUpdates[0]?.output.summary ?? '', /没有高信号文件进入 review 主链/);
});

test('limits concurrent LLM calls independently from file workers', async () => {
  const originalFileConcurrency = config.REVIEW_FILE_CONCURRENCY;
  const originalLlmConcurrency = config.LLM_REVIEW_CONCURRENCY;
  const originalReviewAgentProfiles = config.REVIEW_AGENT_PROFILES;
  config.REVIEW_FILE_CONCURRENCY = 3;
  config.LLM_REVIEW_CONCURRENCY = 1;
  config.REVIEW_AGENT_PROFILES = 'correctness,security,regression';

  let activeLlmCalls = 0;
  let maxActiveLlmCalls = 0;

  const metadata: PullRequestMetadata = {
    id: 'mr-2',
    title: 'Update configs',
    description: '',
    htmlUrl: 'https://example.com/mr/2',
    owner: 'owner',
    repo: 'repo',
    sourceBranch: 'feature',
    headSha: 'head-sha',
    targetBranch: 'main',
    author: 'tester',
    kind: 'merge_request',
    displayId: '!2',
    baseSha: 'base-sha',
  };
  const emptySync: ReviewCommentSyncResult = {
    attemptedCount: 0,
    postedCount: 0,
    deletedCount: 0,
    outdatedCount: 0,
    failedCount: 0,
  };
  const provider: ISCMProvider = {
    async getReviewMetadata(): Promise<PullRequestMetadata> {
      return metadata;
    },
    async getDiff(): Promise<FileDiff[]> {
      return [
        buildConfigDiff('config/app-a.json'),
        buildConfigDiff('config/app-b.json'),
        buildConfigDiff('config/app-c.json'),
      ];
    },
    async postComments(): Promise<ReviewCommentSyncResult> {
      return emptySync;
    },
    async getFileContent(_owner: string, _repo: string, filePath: string): Promise<string> {
      return JSON.stringify({ filePath, secure: true, retries: 3 });
    },
    async searchCode(): Promise<string[]> {
      return [];
    },
    async createReviewStatus(): Promise<ReviewCheckRun | null> {
      return { id: 2, name: 'AI Review' };
    },
    async updateReviewStatus(): Promise<void> {},
  };

  const pipeline = new ReviewPipeline(provider);
  const pipelineInternals = pipeline as unknown as {
    llmProvider: {
      generateReview: (prompt: string, filePath: string) => Promise<ReviewComment[]>;
    };
    checkoutManager: {
      checkout: () => Promise<{ rootDir: string; cleanup: () => Promise<void> }>;
    };
  };

  pipelineInternals.llmProvider = {
    generateReview: async (_prompt: string, filePath: string) => {
      activeLlmCalls += 1;
      maxActiveLlmCalls = Math.max(maxActiveLlmCalls, activeLlmCalls);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      activeLlmCalls -= 1;
      return [{
        path: filePath,
        line: 2,
        body: '**[test]** synthetic comment',
        side: 'RIGHT',
      }];
    },
  };
  pipelineInternals.checkoutManager = {
    checkout: async () => ({
      rootDir: process.cwd(),
      cleanup: async () => {},
    }),
  };

  try {
    const result = await pipeline.run({
      kind: 'merge_request',
      owner: 'owner',
      repo: 'repo',
      number: 2,
    });

    assert.equal(result.reviewedFileCount, 3);
    assert.equal(result.comments.length, 3);
    assert.equal(maxActiveLlmCalls, 1);
  } finally {
    config.REVIEW_FILE_CONCURRENCY = originalFileConcurrency;
    config.LLM_REVIEW_CONCURRENCY = originalLlmConcurrency;
    config.REVIEW_AGENT_PROFILES = originalReviewAgentProfiles;
  }
});

test('runs multiple reviewer agents and merges their comments per file', async () => {
  const originalReviewAgentProfiles = config.REVIEW_AGENT_PROFILES;
  config.REVIEW_AGENT_PROFILES = 'correctness,security,regression';

  const metadata: PullRequestMetadata = {
    id: 'mr-3',
    title: 'Harden controller flow',
    description: '',
    htmlUrl: 'https://example.com/mr/3',
    owner: 'owner',
    repo: 'repo',
    sourceBranch: 'feature',
    headSha: 'head-sha',
    targetBranch: 'main',
    author: 'tester',
    kind: 'merge_request',
    displayId: '!3',
    baseSha: 'base-sha',
  };
  const provider: ISCMProvider = {
    async getReviewMetadata(): Promise<PullRequestMetadata> {
      return metadata;
    },
    async getDiff(): Promise<FileDiff[]> {
      return [buildConfigDiff('src/app/controller.ts')];
    },
    async postComments(
      _target: ReviewTarget,
      _loadedMetadata: PullRequestMetadata,
      comments: ReviewComment[]
    ): Promise<ReviewCommentSyncResult> {
      return {
        attemptedCount: comments.length,
        postedCount: comments.length,
        deletedCount: 0,
        outdatedCount: 0,
        failedCount: 0,
      };
    },
    async getFileContent(): Promise<string> {
      return 'export async function handle(input: Input) { return authorize(input); }';
    },
    async searchCode(): Promise<string[]> {
      return [];
    },
    async createReviewStatus(): Promise<ReviewCheckRun | null> {
      return { id: 3, name: 'AI Review' };
    },
    async updateReviewStatus(): Promise<void> {},
  };

  const pipeline = new ReviewPipeline(provider);
  const pipelineInternals = pipeline as unknown as {
    llmProvider: {
      generateReview: (prompt: string, filePath: string) => Promise<ReviewComment[]>;
    };
    checkoutManager: {
      checkout: () => Promise<{ rootDir: string; cleanup: () => Promise<void> }>;
    };
  };

  pipelineInternals.llmProvider = {
    generateReview: async (prompt: string, filePath: string) => {
      if (prompt.includes('Correctness Agent')) {
        return [{
          path: filePath,
          line: 2,
          body: '**[correctness]** missing error handling',
          side: 'RIGHT',
        }];
      }

      if (prompt.includes('Security Agent')) {
        return [{
          path: filePath,
          line: 3,
          body: '**[security]** input validation is incomplete',
          side: 'RIGHT',
        }];
      }

      return [{
        path: filePath,
        line: 4,
        body: '**[regression]** removed fallback may break callers',
        side: 'RIGHT',
      }];
    },
  };
  pipelineInternals.checkoutManager = {
    checkout: async () => ({
      rootDir: process.cwd(),
      cleanup: async () => {},
    }),
  };

  try {
    const result = await pipeline.run({
      kind: 'merge_request',
      owner: 'owner',
      repo: 'repo',
      number: 3,
    });

    assert.equal(result.comments.length, 3);
    assert.equal(result.commentSync.postedCount, 3);
    assert.match(result.comments[0]?.body ?? '', /\[correctness\]|\[security\]|\[regression\]/);
  } finally {
    config.REVIEW_AGENT_PROFILES = originalReviewAgentProfiles;
  }
});

function buildConfigDiff(path: string): FileDiff {
  return {
    path,
    status: 'modified',
    chunks: [
      {
        content: '@@ -1,1 +1,2 @@\n-{"secure":false}\n+{"secure":true,\n+"retries":3}',
        oldRange: { start: 1, lines: 1 },
        newRange: { start: 1, lines: 2 },
      },
    ],
  };
}
