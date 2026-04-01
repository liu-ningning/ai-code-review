/**
 * 提供 unified diff 到内部结构化 diff 的转换能力。
 *
 * 这个文件负责解析 GitLab 返回的 patch 字符串，把 hunk 拆成
 * review 流程可消费的 `FileDiff` 结构。
 */
import { DiffChunk, FileDiff } from '../../types/index.js';

/**
 * 解析 SCM 返回的 patch，并提取文件级 hunk 信息。
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
      // 匹配 @@ -oldStart,oldLines +newStart,newLines @@
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
