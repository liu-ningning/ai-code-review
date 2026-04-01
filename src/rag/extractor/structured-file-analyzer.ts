/**
 * 为非 TS/JS 文件提供结构化摘要提取能力。
 *
 * 这个文件不尝试做完整语义执行，而是把 YAML / JSON / Shell 等文件
 * 里的结构信息压缩成可注入 prompt 的摘要，帮助 review 理解“改的是哪块配置”。
 */
import path from 'node:path';
import { CodeContextSnippet, FileDiff } from '../../types/index.js';
import { getTouchedNewLineEntries } from '../../core/review/diff-utils.js';

/**
 * 针对结构化文件提取适合放入 RAG 的高信号摘要。
 */
export class StructuredFileAnalyzer {
  /**
   * 根据文件类型提取结构化摘要。
   */
  analyze(filePath: string, content: string, diff: FileDiff): CodeContextSnippet[] {
    if (!content) {
      return [];
    }

    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    const extension = path.posix.extname(normalizedPath);

    if (extension === '.yml' || extension === '.yaml') {
      return this.analyzeYamlLikeFile(filePath, content, diff);
    }

    if (extension === '.json' || extension === '.jsonc') {
      return this.analyzeJsonLikeFile(filePath, content, diff);
    }

    if (extension === '.toml' || extension === '.ini' || extension === '.conf' || extension === '.properties') {
      return this.analyzeKeyValueConfigFile(filePath, content, diff);
    }

    if (/\.(sh|bash|zsh)$/.test(extension) || path.posix.basename(normalizedPath) === 'dockerfile') {
      return this.analyzeShellLikeFile(filePath, content, diff);
    }

    return [];
  }

  /**
   * 提取 YAML 类配置的关键路径和 CI 作业结构摘要。
   */
  private analyzeYamlLikeFile(filePath: string, content: string, diff: FileDiff): CodeContextSnippet[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const touchedLines = new Set(getTouchedNewLineEntries(diff).map((entry) => entry.line));
    const keyPaths: string[] = [];
    const stack: Array<{ indent: number; key: string }> = [];
    const jobs = new Map<string, { stage?: string; needs: string[]; when?: string; allowFailure?: string }>();

    stack.length = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || /^\s*#/.test(line)) {
        continue;
      }

      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      const keyMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!keyMatch) {
        continue;
      }

      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const key = keyMatch[1];
      stack.push({ indent, key });
      const keyPath = stack.map((segment) => segment.key).join('.');
      if (touchedLines.has(index + 1)) {
        keyPaths.push(keyPath);
      }

      if (indent === 0 && !['stages', 'workflow', 'default', 'variables', 'include'].includes(key)) {
        jobs.set(key, { stage: undefined, needs: [], when: undefined, allowFailure: undefined });
      }

      const currentTopLevelKey = stack[0]?.key;
      if (currentTopLevelKey && jobs.has(currentTopLevelKey) && stack.length >= 2) {
        const value = keyMatch[2].trim();
        const job = jobs.get(currentTopLevelKey)!;
        if (key === 'stage' && value) {
          job.stage = value;
        }
        if (key === 'when' && value) {
          job.when = value;
        }
        if (key === 'allow_failure' && value) {
          job.allowFailure = value;
        }
        if (key === 'needs' && value) {
          job.needs.push(value);
        }
      }
    }

    const uniqueKeyPaths = Array.from(new Set(keyPaths));
    const snippets: CodeContextSnippet[] = [];

    if (uniqueKeyPaths.length > 0) {
      snippets.push({
        label: '配置键路径摘要',
        file: filePath,
        content: uniqueKeyPaths.slice(0, 8).map((item) => `- ${item}`).join('\n'),
      });
    }

    const jobSummaries = Array.from(jobs.entries())
      .slice(0, 6)
      .map(([jobName, job]) => {
        const parts = [`job=${jobName}`];
        if (job.stage) parts.push(`stage=${job.stage}`);
        if (job.when) parts.push(`when=${job.when}`);
        if (job.allowFailure) parts.push(`allow_failure=${job.allowFailure}`);
        if (job.needs.length > 0) parts.push(`needs=${job.needs.join(',')}`);
        return `- ${parts.join(' | ')}`;
      });

    if (jobSummaries.length > 0 && (normalizedIncludesCiPath(filePath) || uniqueKeyPaths.some((item) => item.startsWith('jobs.') || item.includes('.script')))) {
      snippets.push({
        label: 'CI 结构摘要',
        file: filePath,
        content: jobSummaries.join('\n'),
      });
    }

    return snippets;
  }

  /**
   * 提取 JSON/JSONC 配置里被改动的关键字段。
   */
  private analyzeJsonLikeFile(filePath: string, content: string, diff: FileDiff): CodeContextSnippet[] {
    const touchedEntries = getTouchedNewLineEntries(diff);
    const touchedKeys = touchedEntries
      .map((entry) => entry.text.match(/"([^"]+)"\s*:/)?.[1] ?? entry.text.match(/([A-Za-z0-9_.-]+)\s*:/)?.[1] ?? '')
      .filter(Boolean);
    const snippets: CodeContextSnippet[] = [];

    if (touchedKeys.length > 0) {
      snippets.push({
        label: 'JSON 键摘要',
        file: filePath,
        content: Array.from(new Set(touchedKeys)).slice(0, 10).map((key) => `- ${key}`).join('\n'),
      });
    }

    try {
      const parsed = JSON.parse(content.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        snippets.push({
          label: 'JSON 顶层结构',
          file: filePath,
          content: Object.keys(parsed).slice(0, 10).map((key) => `- ${key}`).join('\n'),
        });
      }
    } catch {
      // ignore invalid JSON/JSONC and keep touched-key summary only
    }

    return snippets;
  }

  /**
   * 提取 TOML/INI/CONF/Properties 这类键值配置中的关键节和键。
   */
  private analyzeKeyValueConfigFile(filePath: string, content: string, diff: FileDiff): CodeContextSnippet[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const touchedLines = new Set(getTouchedNewLineEntries(diff).map((entry) => entry.line));
    const sectionStack: string[] = [];
    const changedKeys: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) {
        continue;
      }

      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        sectionStack.length = 0;
        sectionStack.push(sectionMatch[1].trim());
        continue;
      }

      const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*[:=]/);
      if (!keyMatch || !touchedLines.has(index + 1)) {
        continue;
      }

      changedKeys.push([...sectionStack, keyMatch[1]].filter(Boolean).join('.'));
    }

    if (changedKeys.length === 0) {
      return [];
    }

    return [{
      label: '配置节摘要',
      file: filePath,
      content: Array.from(new Set(changedKeys)).slice(0, 10).map((item) => `- ${item}`).join('\n'),
    }];
  }

  /**
   * 提取 Shell / Dockerfile 里的命令级结构摘要。
   */
  private analyzeShellLikeFile(filePath: string, content: string, diff: FileDiff): CodeContextSnippet[] {
    const commands: string[] = [];
    for (const entry of getTouchedNewLineEntries(diff)) {
      const trimmed = entry.text.trim();
      if (!trimmed || trimmed.startsWith('#') || /^\b(if|then|else|fi|for|do|done|while|case|esac)\b/.test(trimmed)) {
        continue;
      }

      const withoutEnvPrefix = trimmed.replace(/^([A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|[^\s]+)\s+)*/, '');
      const commandMatch = withoutEnvPrefix.match(/^([A-Za-z0-9_./:-]+)/);
      if (commandMatch) {
        commands.push(commandMatch[1]);
      }
    }

    if (commands.length === 0) {
      return [];
    }

    return [{
      label: '命令结构摘要',
      file: filePath,
      content: Array.from(new Set(commands)).slice(0, 10).map((command) => `- ${command}`).join('\n'),
    }];
  }

}

function normalizedIncludesCiPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized === '.gitlab-ci.yml'
    || normalized.startsWith('.gitlab/')
    || normalized.startsWith('.github/workflows/')
    || normalized.startsWith('.circleci/')
    || normalized.startsWith('.buildkite/');
}
