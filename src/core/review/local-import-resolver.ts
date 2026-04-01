/**
 * 提供本地 import 的静态路径解析能力。
 *
 * 这个文件负责读取仓库里的 tsconfig/jsconfig 路径映射配置，
 * 把 alias import 和相对路径 import 解析成真实文件，供静态分析复用。
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LRUCache } from 'lru-cache';
import ts from 'typescript';
import { normalizeRepoPath } from './script-file-utils.js';

interface AliasMapping {
  pattern: string;
  patternPrefix: string;
  patternSuffix: string;
  targets: string[];
}

const COMMON_TSCONFIG_FILES = [
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'jsconfig.json',
];

const RESOLUTION_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.d.ts',
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.cts',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
  '/index.d.ts',
];

/**
 * 基于 tsconfig/jsconfig 路径映射解析本地 import，辅助静态分析追踪依赖边。
 */
export class LocalImportResolver {
  private static readonly aliasMappingsCache = new LRUCache<string, AliasMapping[]>({
    max: 64,
    ttl: 10 * 60 * 1000,
  });

  private readonly aliasMappings: AliasMapping[] = [];
  private readonly loadedConfigs = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly cacheScope: string
  ) {}

  /**
   * 读取并缓存仓库里的 tsconfig/jsconfig 路径映射配置。
   */
  async initialize(): Promise<void> {
    const cachedMappings = LocalImportResolver.aliasMappingsCache.get(this.cacheScope);
    if (cachedMappings) {
      this.aliasMappings.push(...cachedMappings.map((mapping) => ({
        ...mapping,
        targets: [...mapping.targets],
      })));
      return;
    }

    for (const configPath of COMMON_TSCONFIG_FILES) {
      if (existsSync(path.join(this.rootDir, configPath))) {
        await this.loadConfig(configPath);
      }
    }

    LocalImportResolver.aliasMappingsCache.set(
      this.cacheScope,
      this.aliasMappings.map((mapping) => ({
        ...mapping,
        targets: [...mapping.targets],
      }))
    );
  }

  /**
   * 把 import specifier 解析成仓库内的真实文件路径。
   */
  resolveImport(fromRepoPath: string, specifier: string): string | undefined {
    if (specifier.startsWith('.')) {
      return this.resolveCandidateBase(
        path.posix.normalize(path.posix.join(path.posix.dirname(fromRepoPath), specifier))
      );
    }

    for (let index = this.aliasMappings.length - 1; index >= 0; index -= 1) {
      const mapping = this.aliasMappings[index];
      const wildcardValue = this.extractWildcard(mapping, specifier);
      if (wildcardValue === null) {
        continue;
      }

      for (const targetPattern of mapping.targets) {
        const candidateBase = targetPattern.includes('*')
          ? targetPattern.replace('*', wildcardValue)
          : targetPattern;
        const resolved = this.resolveCandidateBase(candidateBase);
        if (resolved) {
          return resolved;
        }
      }
    }

    return undefined;
  }

  /**
   * 递归加载一个 tsconfig/jsconfig 文件，并提取其中的路径别名配置。
   */
  private async loadConfig(configRepoPath: string): Promise<void> {
    const normalizedPath = normalizeRepoPath(configRepoPath);
    if (this.loadedConfigs.has(normalizedPath)) {
      return;
    }

    this.loadedConfigs.add(normalizedPath);

    const absolutePath = path.join(this.rootDir, normalizedPath);
    let content = '';
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch {
      return;
    }

    const parsed = ts.parseConfigFileTextToJson(normalizedPath, content);
    const configObject = parsed.config;
    if (!configObject || typeof configObject !== 'object') {
      return;
    }

    const extendsEntry = typeof configObject.extends === 'string' ? configObject.extends.trim() : '';
    if (extendsEntry && (extendsEntry.startsWith('.') || extendsEntry.startsWith('/'))) {
      const extendedConfigPath = normalizeRepoPath(
        path.posix.join(
          path.posix.dirname(normalizedPath),
          extendsEntry.endsWith('.json') ? extendsEntry : `${extendsEntry}.json`
        )
      );
      if (existsSync(path.join(this.rootDir, extendedConfigPath))) {
        await this.loadConfig(extendedConfigPath);
      }
    }

    const compilerOptions = typeof configObject.compilerOptions === 'object' && configObject.compilerOptions
      ? configObject.compilerOptions
      : {};
    const rawPaths = typeof compilerOptions.paths === 'object' && compilerOptions.paths
      ? compilerOptions.paths
      : {};
    const configDir = path.posix.dirname(normalizedPath);
    const baseUrl = normalizeRepoPath(path.posix.join(configDir, compilerOptions.baseUrl || '.'));

    for (const [pattern, targetList] of Object.entries(rawPaths) as Array<[string, unknown]>) {
      if (!Array.isArray(targetList) || targetList.length === 0) {
        continue;
      }

      const wildcardIndex = pattern.indexOf('*');
      const targets = targetList
        .filter((target): target is string => typeof target === 'string')
        .map((target) => normalizeRepoPath(path.posix.join(baseUrl, target)));

      this.aliasMappings.push({
        pattern,
        patternPrefix: wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex),
        patternSuffix: wildcardIndex === -1 ? '' : pattern.slice(wildcardIndex + 1),
        targets,
      });
    }
  }

  /**
   * 根据别名模式判断 specifier 是否命中，并提取 `*` 对应的具体值。
   */
  private extractWildcard(mapping: AliasMapping, specifier: string): string | null {
    if (!mapping.pattern.includes('*')) {
      return mapping.pattern === specifier ? '' : null;
    }

    if (!specifier.startsWith(mapping.patternPrefix) || !specifier.endsWith(mapping.patternSuffix)) {
      return null;
    }

    return specifier.slice(
      mapping.patternPrefix.length,
      specifier.length - mapping.patternSuffix.length
    );
  }

  /**
   * 按约定扩展名尝试解析一个候选基础路径对应的真实脚本文件。
   */
  private resolveCandidateBase(basePath: string): string | undefined {
    for (const extension of RESOLUTION_EXTENSIONS) {
      const candidate = normalizeRepoPath(`${basePath}${extension}`);
      const absoluteCandidate = path.join(this.rootDir, candidate);
      if (!existsSync(absoluteCandidate)) {
        continue;
      }

      try {
        if (statSync(absoluteCandidate).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
