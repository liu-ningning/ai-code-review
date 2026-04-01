/**
 * 提供 unified diff 到内部结构化 diff 的转换能力。
 *
 * 这个文件负责解析 GitLab 返回的 patch 字符串，把 hunk 拆成
 * review 流程可消费的 `FileDiff` 结构。
 */
import { DiffChunk, FileDiff } from '../../types/index.js';

/**
 * 解析 SCM 返回的 patch，并提取文件级 hunk 信息。
 *
 * 这里有意只做“把原始 patch 按 hunk 边界拆开”这件事，不尝试在 provider 层
 * 推导更细粒度的增删行语义。后续 review 流程会在统一的 `FileDiff` 结构上继续做
 * 行级扫描、上下文补全和提示词构建。
 */
export class DiffParser {
  /**
   * 解析统一 diff patch 字符串为结构化的 FileDiff
   */
  static parsePatch(patch: string, path: string, status: string): FileDiff {
    const chunks: DiffChunk[] = [];
    const lines = patch.split('\n');
    let currentChunk: DiffChunk | null = null;

    for (const line of lines) {
      // 匹配 unified diff hunk header，例如 `@@ -10,2 +12,4 @@`。
      // 某些 diff 会省略行数，此时语义上表示单行，因此默认补成 1。
      const hunkHeader = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (hunkHeader) {
        if (currentChunk) chunks.push(currentChunk);

        currentChunk = {
          content: line + '\n',
          oldRange: { start: parseInt(hunkHeader[1]), lines: parseInt(hunkHeader[2] || '1') },
          newRange: { start: parseInt(hunkHeader[3]), lines: parseInt(hunkHeader[4] || '1') },
        };
        continue;
      }

      if (currentChunk) {
        currentChunk.content += line + '\n';
      }
    }

    if (currentChunk) chunks.push(currentChunk);

    return {
      path,
      chunks,
      status: this.normalizeStatus(status),
    };
  }

  /**
   * 把不同 SCM 返回的字符串状态统一折叠到内部允许的枚举上。
   *
   * provider 上游偶尔会出现未知状态或空值，这里保守退回 `modified`，
   * 避免因为状态解析失败直接打断整个 review 流程。
   */
  private static normalizeStatus(status: string): FileDiff['status'] {
    switch (status) {
      case 'added':
      case 'modified':
      case 'deleted':
      case 'renamed':
        return status;
      default:
        return 'modified';
    }
  }
}
