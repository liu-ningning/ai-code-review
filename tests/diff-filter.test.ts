/**
 * 验证 diff 噪音过滤、路径忽略和大文件剔除逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DiffFilter } from '../src/core/pipeline/diff-filter.js';
import { createAddedFileDiff } from './helpers.js';

test('filters generic documentation changes out of the review path', () => {
  const docsDiff = createAddedFileDiff('README.md', 'Updated product wording.');

  assert.equal(DiffFilter.filter([docsDiff]).length, 0);
});

test('filters deployment documentation changes out of the review path', () => {
  const deployDocDiff = createAddedFileDiff(
    'docs/deployment.md',
    'Run `docker compose up -d` after exporting DEPLOY_TOKEN.'
  );

  assert.equal(DiffFilter.filter([deployDocDiff]).length, 0);
});

test('filters deployment and ci files out of the review path', () => {
  const workflowDiff = createAddedFileDiff(
    '.github/workflows/release.yml',
    'name: release\njobs:\n  deploy:\n    runs-on: ubuntu-latest'
  );
  const terraformDiff = createAddedFileDiff(
    'infra/production/main.tf',
    'resource "aws_s3_bucket" "app" {}'
  );

  assert.equal(DiffFilter.filter([workflowDiff, terraformDiff]).length, 0);
});
