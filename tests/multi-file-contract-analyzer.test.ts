/**
 * 验证多文件契约分析对导出变更、包装器和基线对比的判断结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiFileContractAnalyzer } from '../src/core/review/multi-file-contract-analyzer.js';
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
import { createAddedFileDiff, createTempDir, normalizeMultiline, runGit, writeFixture } from './helpers.js';

/**
 * 构造带调用计数的基线内容 provider。
 */
function createProviderCounter(baseContents: Record<string, string> = {}): {
  provider: ISCMProvider;
  getFileContentCalls: () => number;
} {
  let fileContentCalls = 0;
  const unusedMetadata: PullRequestMetadata = {
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
      return unusedMetadata;
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
    async getFileContent(_owner: string, _repo: string, filePath: string): Promise<string> {
      fileContentCalls += 1;
      return baseContents[filePath] ?? '';
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

test('tracks contract signature drift through alias imports and namespace member calls', async () => {
  const root = createTempDir('ai-review-contract-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  const modulePath = 'src/lib/user-api.ts';
  const aliasConsumerPath = 'src/services/alias-consumer.ts';
  const namespaceConsumerPath = 'src/services/namespace-consumer.ts';

  const currentModule = normalizeMultiline(`
    export async function updateUser(id: string, name: string, active: boolean) {
      return { id, name, active }
    }
  `);
  const previousModule = normalizeMultiline(`
    export async function updateUser(id: string, name: string) {
      return { id, name }
    }
  `);
  const aliasConsumer = normalizeMultiline(`
    import { updateUser } from '@/lib/user-api'

    export async function runAlias(id: string, name: string) {
      return updateUser(id, name)
    }
  `);
  const namespaceConsumer = normalizeMultiline(`
    import * as userApi from '@/lib/user-api'

    export async function runNamespace(id: string, name: string) {
      return userApi.updateUser(id, name)
    }
  `);

  writeFixture(root, modulePath, currentModule);
  writeFixture(root, aliasConsumerPath, aliasConsumer);
  writeFixture(root, namespaceConsumerPath, namespaceConsumer);

  const analyzer = new MultiFileContractAnalyzer(createProviderCounter({
    [modulePath]: previousModule,
  }).provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, currentModule), status: 'modified' },
      createAddedFileDiff(aliasConsumerPath, aliasConsumer),
      createAddedFileDiff(namespaceConsumerPath, namespaceConsumer),
    ],
    'base'
  );

  assert.deepEqual(
    (result.findingsByPath.get(aliasConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
  assert.deepEqual(
    (result.findingsByPath.get(namespaceConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
});

test('loads baseline contracts from local git refs and resolves named re-export barrels without SCM file fetches', async () => {
  const root = createTempDir('ai-review-contract-git-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  runGit(root, 'init');
  runGit(root, 'config', 'user.email', 'tester@example.com');
  runGit(root, 'config', 'user.name', 'Tester');

  const modulePath = 'src/lib/user-api.ts';
  const barrelPath = 'src/lib/index.ts';
  const directConsumerPath = 'src/services/direct-consumer.ts';
  const namespaceConsumerPath = 'src/services/namespace-consumer.ts';

  writeFixture(root, modulePath, normalizeMultiline(`
    export async function updateUser(id: string, name: string) {
      return { id, name }
    }
  `));
  writeFixture(root, barrelPath, "export { updateUser } from './user-api'\n");
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-m', 'base');
  const baseSha = runGit(root, 'rev-parse', 'HEAD');

  writeFixture(root, modulePath, normalizeMultiline(`
    export async function updateUser(id: string, name: string, active: boolean) {
      return { id, name, active }
    }
  `));
  writeFixture(root, directConsumerPath, normalizeMultiline(`
    import { updateUser } from '@/lib'

    export async function runDirect(id: string, name: string) {
      return updateUser(id, name)
    }
  `));
  writeFixture(root, namespaceConsumerPath, normalizeMultiline(`
    import * as api from '@/lib'

    export async function runNamespace(id: string, name: string) {
      return api.updateUser(id, name)
    }
  `));
  runGit(root, 'add', '.');
  runGit(root, 'commit', '-m', 'head');

  const { provider, getFileContentCalls } = createProviderCounter();
  const analyzer = new MultiFileContractAnalyzer(provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, normalizeMultiline(`
        export async function updateUser(id: string, name: string, active: boolean) {
          return { id, name, active }
        }
      `)), status: 'modified' },
      createAddedFileDiff(directConsumerPath, normalizeMultiline(`
        import { updateUser } from '@/lib'

        export async function runDirect(id: string, name: string) {
          return updateUser(id, name)
        }
      `)),
      createAddedFileDiff(namespaceConsumerPath, normalizeMultiline(`
        import * as api from '@/lib'

        export async function runNamespace(id: string, name: string) {
          return api.updateUser(id, name)
        }
      `)),
    ],
    baseSha
  );

  assert.deepEqual(
    (result.findingsByPath.get(directConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
  assert.deepEqual(
    (result.findingsByPath.get(namespaceConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
  assert.equal(getFileContentCalls(), 0);
});

test('tracks contract signature drift through export-star barrels', async () => {
  const root = createTempDir('ai-review-contract-export-star-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  const modulePath = 'src/lib/user-api.ts';
  const barrelPath = 'src/lib/index.ts';
  const consumerPath = 'src/services/export-star-consumer.ts';

  writeFixture(root, modulePath, normalizeMultiline(`
    export async function updateUser(id: string, name: string, active: boolean) {
      return { id, name, active }
    }
  `));
  writeFixture(root, barrelPath, "export * from './user-api'\n");
  writeFixture(root, consumerPath, normalizeMultiline(`
    import { updateUser } from '@/lib'

    export async function run(id: string, name: string) {
      return updateUser(id, name)
    }
  `));

  const analyzer = new MultiFileContractAnalyzer(createProviderCounter({
    [modulePath]: normalizeMultiline(`
      export async function updateUser(id: string, name: string) {
        return { id, name }
      }
    `),
  }).provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, normalizeMultiline(`
        export async function updateUser(id: string, name: string, active: boolean) {
          return { id, name, active }
        }
      `)), status: 'modified' },
      createAddedFileDiff(consumerPath, normalizeMultiline(`
        import { updateUser } from '@/lib'

        export async function run(id: string, name: string) {
          return updateUser(id, name)
        }
      `)),
    ],
    'base'
  );

  assert.deepEqual(
    (result.findingsByPath.get(consumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
});

test('tracks contract signature drift through export-namespace barrels', async () => {
  const root = createTempDir('ai-review-contract-export-ns-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  const modulePath = 'src/lib/user-api.ts';
  const barrelPath = 'src/lib/index.ts';
  const namedConsumerPath = 'src/services/export-namespace-named-consumer.ts';
  const namespaceConsumerPath = 'src/services/export-namespace-consumer.ts';

  writeFixture(root, modulePath, normalizeMultiline(`
    export async function updateUser(id: string, name: string, active: boolean) {
      return { id, name, active }
    }
  `));
  writeFixture(root, barrelPath, "export * as api from './user-api'\n");
  writeFixture(root, namedConsumerPath, normalizeMultiline(`
    import { api } from '@/lib'

    export async function runNamed(id: string, name: string) {
      return api.updateUser(id, name)
    }
  `));
  writeFixture(root, namespaceConsumerPath, normalizeMultiline(`
    import * as lib from '@/lib'

    export async function runNamespace(id: string, name: string) {
      return lib.api.updateUser(id, name)
    }
  `));

  const analyzer = new MultiFileContractAnalyzer(createProviderCounter({
    [modulePath]: normalizeMultiline(`
      export async function updateUser(id: string, name: string) {
        return { id, name }
      }
    `),
  }).provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, normalizeMultiline(`
        export async function updateUser(id: string, name: string, active: boolean) {
          return { id, name, active }
        }
      `)), status: 'modified' },
      createAddedFileDiff(namedConsumerPath, normalizeMultiline(`
        import { api } from '@/lib'

        export async function runNamed(id: string, name: string) {
          return api.updateUser(id, name)
        }
      `)),
      createAddedFileDiff(namespaceConsumerPath, normalizeMultiline(`
        import * as lib from '@/lib'

        export async function runNamespace(id: string, name: string) {
          return lib.api.updateUser(id, name)
        }
      `)),
    ],
    'base'
  );

  assert.deepEqual(
    (result.findingsByPath.get(namedConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
  assert.deepEqual(
    (result.findingsByPath.get(namespaceConsumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
});

test('reports direct call sites when an exported symbol changes from function to value', async () => {
  const root = createTempDir('ai-review-contract-kind-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  const modulePath = 'src/lib/build-user.ts';
  const consumerPath = 'src/services/build-user-consumer.ts';

  writeFixture(root, modulePath, 'export const buildUser = { enabled: true }\n');
  writeFixture(root, consumerPath, normalizeMultiline(`
    import { buildUser } from '@/lib/build-user'

    export function run() {
      return buildUser('123')
    }
  `));

  const analyzer = new MultiFileContractAnalyzer(createProviderCounter({
    [modulePath]: normalizeMultiline(`
      export function buildUser(id: string) {
        return id
      }
    `),
  }).provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, 'export const buildUser = { enabled: true }\n'), status: 'modified' },
      createAddedFileDiff(consumerPath, normalizeMultiline(`
        import { buildUser } from '@/lib/build-user'

        export function run() {
          return buildUser('123')
        }
      `)),
    ],
    'base'
  );

  assert.deepEqual(
    (result.findingsByPath.get(consumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-export-kind-drift']
  );
});

test('tracks contract drift through static alias wrappers and string-literal member access', async () => {
  const root = createTempDir('ai-review-contract-wrapper-');

  writeFixture(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@/*': ['src/*'],
      },
    },
  }, null, 2));

  const modulePath = 'src/lib/user-api.ts';
  const consumerPath = 'src/services/wrapper-consumer.ts';

  writeFixture(root, modulePath, normalizeMultiline(`
    export async function updateUser(id: string, name: string, active: boolean) {
      return { id, name, active }
    }
  `));
  writeFixture(root, consumerPath, normalizeMultiline(`
    import * as api from '@/lib/user-api'

    const runner = api['updateUser']
    const registry = {
      run: runner,
    }

    export async function execute(id: string, name: string) {
      return registry['run'](id, name)
    }
  `));

  const analyzer = new MultiFileContractAnalyzer(createProviderCounter({
    [modulePath]: normalizeMultiline(`
      export async function updateUser(id: string, name: string) {
        return { id, name }
      }
    `),
  }).provider);
  const result = await analyzer.analyze(
    root,
    'owner',
    'repo',
    [
      { ...createAddedFileDiff(modulePath, normalizeMultiline(`
        export async function updateUser(id: string, name: string, active: boolean) {
          return { id, name, active }
        }
      `)), status: 'modified' },
      createAddedFileDiff(consumerPath, normalizeMultiline(`
        import * as api from '@/lib/user-api'

        const runner = api['updateUser']
        const registry = {
          run: runner,
        }

        export async function execute(id: string, name: string) {
          return registry['run'](id, name)
        }
      `)),
    ],
    'base'
  );

  assert.deepEqual(
    (result.findingsByPath.get(consumerPath) ?? []).map((finding) => finding.ruleId),
    ['contract-function-signature-drift']
  );
});
