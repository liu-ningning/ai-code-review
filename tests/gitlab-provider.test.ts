/**
 * 验证 GitLab provider 对 MR 详情、diff 和评论接口的适配行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabProvider } from '../src/providers/scm/gitlab.provider.js';

test('searchCode paginates GitLab search results and deduplicates file paths', async () => {
  const provider = new GitLabProvider({
    token: 'token',
    baseUrl: 'https://gitlab.example.com',
  });

  const requestedPages: number[] = [];
  (provider as unknown as {
    client: {
      get: (url: string, options?: { params?: Record<string, string | number> }) => Promise<{
        data: Array<{ path?: string }>;
        headers: Record<string, string>;
      }>;
    };
  }).client = {
    get: async (_url, options) => {
      const currentPage = Number(options?.params?.page ?? 1);
      requestedPages.push(currentPage);

      if (currentPage === 1) {
        return {
          data: [
            { path: 'src/first.ts' },
            { path: 'src/shared.ts' },
          ],
          headers: { 'x-next-page': '2' },
        };
      }

      return {
        data: [
          { path: 'src/shared.ts' },
          { path: 'src/second.ts' },
        ],
        headers: { 'x-next-page': '' },
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
