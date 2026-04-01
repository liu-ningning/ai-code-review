/**
 * 验证通用 RAG engine 的符号提取、远程 provider 与预算裁剪逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { RAGEngine } from '../src/rag/rag-engine.js';
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
import type { ReviewFileStrategy } from '../src/core/review/file-review-strategy.js';
import { createTempDir, runGit } from './helpers.js';

/**
 * 构造用于统计 provider 调用次数的测试桩。
 */
function createProviderCounter() {
  let fileContentCalls = 0;
  const metadata: PullRequestMetadata = {
    id: 'unused',
    title: 'unused',
    description: '',
    htmlUrl: 'https://example.com',
    owner: 'owner',
    repo: 'repo',
    sourceBranch: 'feature',
    headSha: 'head',
    targetBranch: 'main',
    author: 'tester',
    kind: 'merge_request',
    displayId: '!1',
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
    async getDiff(_target: ReviewTarget, _metadata: PullRequestMetadata): Promise<FileDiff[]> {
      return [];
    },
    async postComments(
      _target: ReviewTarget,
      _metadata: PullRequestMetadata,
      _comments: ReviewComment[],
      _options?: ReviewCommentSyncOptions
    ): Promise<ReviewCommentSyncResult> {
      return emptySync;
    },
    async getFileContent(): Promise<string> {
      fileContentCalls += 1;
      return '';
    },
    async searchCode(): Promise<string[]> {
      return [];
    },
    async createReviewStatus(
      _metadata: PullRequestMetadata,
      _payload: ReviewCheckRunPayload
    ): Promise<ReviewCheckRun | null> {
      return null;
    },
    async updateReviewStatus(
      _metadata: PullRequestMetadata,
      _checkRun: ReviewCheckRun,
      _payload: ReviewCheckRunUpdatePayload
    ): Promise<void> {
      return;
    },
  };

  return {
    provider,
    getFileContentCalls: () => fileContentCalls,
  };
}

test('loads removed-scope context from the baseline git ref instead of the current checkout tree', async () => {
  const root = createTempDir('ai-review-rag-');
  const filePath = 'src/service.ts';
  mkdirSync(path.join(root, 'src'), { recursive: true });

  runGit(root, 'init');
  runGit(root, 'config', 'user.email', 'tester@example.com');
  runGit(root, 'config', 'user.name', 'Tester');

  writeFileSync(path.join(root, filePath), [
    'export function guard(value: string | null) {',
    '  if (!value) {',
    "    return 'fallback'",
    '  }',
    '  return value',
    '}',
    '',
  ].join('\n'));
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-m', 'base');
  const baseSha = runGit(root, 'rev-parse', 'HEAD');

  writeFileSync(path.join(root, filePath), [
    'export function guard(value: string | null) {',
    '  return value',
    '}',
    '',
  ].join('\n'));
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-m', 'head');
  const headSha = runGit(root, 'rev-parse', 'HEAD');

  const diff: FileDiff = {
    path: filePath,
    status: 'modified',
    chunks: [
      {
        content: [
          '@@ -1,6 +1,3 @@',
          ' export function guard(value: string | null) {',
          '-  if (!value) {',
          "-    return 'fallback'",
          '-  }',
          '   return value',
          ' }',
        ].join('\n'),
        oldRange: { start: 1, lines: 6 },
        newRange: { start: 1, lines: 3 },
      },
    ],
  };

  const strategy: ReviewFileStrategy = {
    kind: 'backend_module',
    label: 'backend',
    focusAreas: [],
    signalBudget: 0,
    codeContextBudget: 0,
    tableContextBudget: 0,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [],
      typedEslintRuleIds: [],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: false,
      maxRemoteSymbolLookups: 0,
      maxSearchResultsPerLookup: 0,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 0,
      maxTypeContexts: 0,
      maxSemanticSlices: 0,
      maxDeletedScopeContexts: 2,
    },
  };

  const { provider, getFileContentCalls } = createProviderCounter();
  const context = await new RAGEngine(provider, root).extract('owner', 'repo', diff, {
    targetRef: headSha,
    baselineRef: baseSha,
    initialSignals: [],
    strategy,
  });

  assert.ok(context.deletedScopes.some((scope) => scope.content.includes("return 'fallback'")));
  assert.equal(getFileContentCalls(), 0);
});
