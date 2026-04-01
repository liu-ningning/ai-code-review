/**
 * 提供 diff 行级辅助能力。
 *
 * 这个文件负责从 unified diff 中提取“新增行”的行号和内容，
 * 供静态分析、行号校验以及评论定位复用。
 */
import { FileDiff } from '../../types/index.js';

/**
 * 表示 diff 新增侧或删除侧中的一条文本行及其定位信息。
 */
export interface TouchedDiffLine {
  line: number;
  text: string;
}

interface CollectedDiffLines {
  added: string[];
  removed: string[];
}

/**
 * 提取当前 diff 中所有新增行的行号和对应文本内容。
 */
export function getTouchedNewLineEntries(diff: FileDiff): TouchedDiffLine[] {
  const touchedLines: TouchedDiffLine[] = [];

  for (const chunk of diff.chunks) {
    const chunkLines = chunk.content.replace(/\r\n/g, '\n').split('\n');
    let nextNewLine = chunk.newRange.start;

    for (const line of chunkLines) {
      if (!line || line.startsWith('@@')) {
        continue;
      }

      if (line.startsWith('\\')) {
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        touchedLines.push({ line: nextNewLine, text: line.slice(1) });
        nextNewLine += 1;
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        continue;
      }

      nextNewLine += 1;
    }
  }

  return touchedLines;
}

/**
 * 提取当前 diff 中所有删除行在旧文件中的行号和文本内容。
 */
export function getRemovedOldLineEntries(diff: FileDiff): TouchedDiffLine[] {
  const removedLines: TouchedDiffLine[] = [];

  for (const chunk of diff.chunks) {
    const chunkLines = chunk.content.replace(/\r\n/g, '\n').split('\n');
    let nextOldLine = chunk.oldRange.start;

    for (const line of chunkLines) {
      if (!line || line.startsWith('@@')) {
        continue;
      }

      if (line.startsWith('\\')) {
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        removedLines.push({ line: nextOldLine, text: line.slice(1) });
        nextOldLine += 1;
        continue;
      }

      nextOldLine += 1;
    }
  }

  return removedLines;
}

/**
 * 提取当前 diff 中所有新增行的行号集合。
 */
export function getTouchedNewLines(diff: FileDiff): Set<number> {
  return new Set(getTouchedNewLineEntries(diff).map((entry) => entry.line));
}

/**
 * 计算当前 diff 在新文件侧最值得关注的锚点行号。
 *
 * 如果存在新增行，优先使用新增行；
 * 如果改动以删除为主，则回退到 hunk 对应的新文件范围附近，保证后续作用域提取仍有锚点。
 */
export function getChangedNewLineAnchors(diff: FileDiff): number[] {
  const touchedLines = Array.from(getTouchedNewLines(diff)).sort((left, right) => left - right);
  if (touchedLines.length > 0) {
    return touchedLines;
  }

  const anchors = new Set<number>();
  for (const chunk of diff.chunks) {
    const startLine = Math.max(1, chunk.newRange.start);
    const endLine = chunk.newRange.lines > 0
      ? startLine + chunk.newRange.lines - 1
      : startLine;

    anchors.add(Math.max(1, startLine - 1));
    anchors.add(startLine);
    anchors.add(endLine);
    anchors.add(endLine + 1);
  }

  return Array.from(anchors).sort((left, right) => left - right);
}

/**
 * 判断某一行是否属于当前 diff 的新增行。
 */
export function isTouchedNewLine(diff: FileDiff, line: number): boolean {
  return getTouchedNewLines(diff).has(line);
}

/**
 * 判断给定行号区间内是否至少包含一行当前 diff 的新增内容。
 */
export function hasTouchedNewLineInRange(diff: FileDiff, startLine: number, endLine: number): boolean {
  const touchedLines = getTouchedNewLines(diff);
  for (let line = startLine; line <= endLine; line += 1) {
    if (touchedLines.has(line)) {
      return true;
    }
  }

  return false;
}

/**
 * 把相距较远的 hunk 拆成多个局部评审段，减少单次提示词中的无关上下文。
 */
export function splitDiffIntoReviewSegments(
  diff: FileDiff,
  options: {
    maxGapLines?: number;
    maxSegments?: number;
  } = {}
): FileDiff[] {
  if (diff.chunks.length <= 1) {
    return [diff];
  }

  const maxGapLines = options.maxGapLines ?? 24;
  const maxSegments = options.maxSegments ?? 4;
  const segments: typeof diff.chunks[] = [];
  let currentSegment: typeof diff.chunks = [diff.chunks[0]];

  for (const chunk of diff.chunks.slice(1)) {
    const previousChunk = currentSegment[currentSegment.length - 1];
    const previousNewEnd = previousChunk.newRange.start + Math.max(previousChunk.newRange.lines, 1) - 1;
    const currentGap = chunk.newRange.start - previousNewEnd;

    if (currentGap <= maxGapLines) {
      currentSegment.push(chunk);
      continue;
    }

    segments.push(currentSegment);
    currentSegment = [chunk];
  }

  segments.push(currentSegment);

  if (segments.length > maxSegments) {
    return [diff];
  }

  return segments.map((segmentChunks) => ({
    ...diff,
    chunks: segmentChunks,
  }));
}

/**
 * 判断当前 diff 是否只包含空白字符层面的调整。
 */
export function isWhitespaceOnlyDiff(diff: FileDiff): boolean {
  const { added, removed } = collectChangedLines(diff);
  if (added.length === 0 || removed.length === 0 || added.length !== removed.length) {
    return false;
  }

  return added.every((line, index) => normalizeForWhitespaceComparison(line) === normalizeForWhitespaceComparison(removed[index]));
}

/**
 * 统计当前 diff 的新增与删除文本行，用于噪音过滤和影响分析。
 */
export function collectChangedLines(diff: FileDiff): CollectedDiffLines {
  const added: string[] = [];
  const removed: string[] = [];

  for (const chunk of diff.chunks) {
    for (const line of chunk.content.replace(/\r\n/g, '\n').split('\n')) {
      if (!line || line.startsWith('@@') || line.startsWith('\\')) {
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line.slice(1));
        continue;
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        removed.push(line.slice(1));
      }
    }
  }

  return { added, removed };
}

/**
 * 归一化一行文本，用于识别纯空白格式化改动。
 */
function normalizeForWhitespaceComparison(line: string): string {
  return line.replace(/\s+/g, '');
}
