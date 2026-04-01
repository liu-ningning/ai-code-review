/**
 * 验证 GitHub provider 对代码搜索接口的适配行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubProvider } from '../src/providers/scm/github.provider.js';

test('searchCode paginates GitHub search results and deduplicates file paths', async () => {
  const provider = new GitHubProvider({
    token: 'token',
    apiBaseUrl: 'https://api.github.com',
    webBaseUrl: 'https://github.com',
  });

  const requestedPages: number[] = [];
  (provider as unknown as {
    client: {
      get: (url: string, options?: { params?: Record<string, string | number> }) => Promise<{
        data: { items?: Array<{ path?: string }> };
      }>;
    };
  }).client = {
    get: async (_url, options) => {
      const currentPage = Number(options?.params?.page ?? 1);
      requestedPages.push(currentPage);

      if (currentPage === 1) {
        return {
          data: {
            total_count: 150,
            items: [
              { path: 'src/first.ts' },
              { path: 'src/shared.ts' },
            ],
          },
        };
      }

      return {
        data: {
          total_count: 150,
          items: [
            { path: 'src/shared.ts' },
            { path: 'src/second.ts' },
          ],
        },
      };
    },
  };

  const results = await provider.searchCode('owner', 'repo', 'updateUser');

  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(results, [
    'src/first.ts',
    'src/shared.ts',
    'src/second.ts',
  ]);
});
