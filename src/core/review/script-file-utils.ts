/**
 * 提供脚本文件路径与语言类型的基础工具函数。
 *
 * 这个文件负责统一路径规范化、可分析脚本类型判断，以及把文件后缀
 * 映射成 AST 解析所需的 ScriptKind。
 */
import path from 'node:path';
import { ScriptKind } from '@phenomnomnominal/tsquery';

const ANALYZABLE_SCRIPT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * 规范化仓库内文件路径，统一成 POSIX 风格并移除多余的前导 `./`。
 */
export function normalizeRepoPath(filePath: string): string {
  return path.posix.normalize(filePath).replace(/^\.\/+/, '');
}

/**
 * 判断给定路径是否属于当前 review 流程可分析的脚本文件。
 */
export function isAnalyzableScriptPath(filePath: string): boolean {
  return ANALYZABLE_SCRIPT_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

/**
 * 根据文件扩展名选择 tsquery 解析时需要使用的脚本种类。
 */
export function getScriptKindForFile(filePath: string): ScriptKind {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case '.tsx':
      return ScriptKind.TSX;
    case '.jsx':
      return ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ScriptKind.JS;
    default:
      return ScriptKind.TS;
  }
}
