/**
 * 提供测试间可复用的 diff 与文本规范化辅助函数。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDiff } from '../src/types/index.js';

/**
 * 构造一个“整文件新增”场景的最小 FileDiff 结构。
 */
export function createAddedFileDiff(path: string, content: string): FileDiff {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = normalized ? normalized.split('\n') : [];
  return {
    path,
    status: 'added',
    chunks: [
      {
        content: `@@ -0,0 +1,${Math.max(lines.length, 1)} @@\n${lines.map((line) => `+${line}`).join('\n')}`,
        oldRange: { start: 0, lines: 0 },
        newRange: { start: 1, lines: Math.max(lines.length, 1) },
      },
    ],
  };
}

/**
 * 去掉多行字符串首尾的多余空行，便于内联 fixture 书写。
 */
export function normalizeMultiline(input: string): string {
  return input.replace(/^\n+|\n+$/g, '');
}

/**
 * 创建一个用于测试的临时目录，并自动挂到系统临时目录下。
 */
export function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 在临时测试目录中写入一个 fixture 文件，并返回绝对路径。
 */
export function writeFixture(root: string, filePath: string, content: string): string {
  const absolutePath = path.join(root, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

/**
 * 在给定测试仓库中执行 git 命令并返回标准输出。
 */
export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}
