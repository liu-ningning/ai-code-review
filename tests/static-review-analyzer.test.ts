/**
 * 验证静态审查主入口在精简实现下仍保持稳定的调用行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StaticReviewAnalyzer } from '../src/core/review/static-review-analyzer.js';
import { createAddedFileDiff, createTempDir, normalizeMultiline, writeFixture } from './helpers.js';

test('does not treat property names inside useEffect as missing dependencies', async () => {
  const root = createTempDir('ai-review-static-react-');
  const filePath = 'src/components/Demo.tsx';
  const content = normalizeMultiline(`
    import { useEffect } from 'react'

    export function Demo({ user }: any) {
      useEffect(() => {
        console.log(user.name)
      }, [user])

      return null
    }
  `);

  writeFixture(root, filePath, content);
  const result = await new StaticReviewAnalyzer().analyze(root, [
    createAddedFileDiff(filePath, content),
  ], 'static-react');

  const ruleIds = (result.findingsByPath.get(filePath) ?? []).map((finding) => finding.ruleId);
  assert.ok(!ruleIds.includes('react-effect-missing-deps'));
});

test('does not report object-style where clauses as missing ORM write constraints', async () => {
  const root = createTempDir('ai-review-static-orm-');
  const filePath = 'src/services/user-service.ts';
  const content = normalizeMultiline(`
    export async function updateUser(client: any, id: string) {
      return client.user.update({
        where: { id },
        data: { active: true },
      })
    }
  `);

  writeFixture(root, filePath, content);
  const result = await new StaticReviewAnalyzer().analyze(root, [
    createAddedFileDiff(filePath, content),
  ], 'static-orm');

  const ruleIds = (result.findingsByPath.get(filePath) ?? []).map((finding) => finding.ruleId);
  assert.ok(!ruleIds.includes('orm-write-without-where'));
});

test('skips import resolver initialization when no added import edge exists in changed scripts', async () => {
  const root = createTempDir('ai-review-static-no-import-');
  const filePath = 'src/services/user-service.ts';
  const content = normalizeMultiline(`
    export async function loadUser(userModel: any, id: string) {
      return userModel.findUnique({ where: { id } })
    }
  `);

  writeFixture(root, filePath, content);

  let importResolverCreated = false;
  const analyzer = new StaticReviewAnalyzer({
    createImportResolver() {
      importResolverCreated = true;
      return {
        async initialize() {},
        resolveImport() {
          return undefined;
        },
      } as any;
    },
  });

  await analyzer.analyze(root, [
    createAddedFileDiff(filePath, content),
  ], 'static-no-import-edges');

  assert.equal(importResolverCreated, false);
});
