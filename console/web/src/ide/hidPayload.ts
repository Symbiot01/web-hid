/** Characters of `source` that will be typed, in order, and their indexes in `source`. */

export type HidScope = 'file' | 'functions';
export type HidIndent = 'keep' | 'strip';

export type HidPlay = { sent: number; map: number[]; eta: string; paused?: boolean };

export function estimateHidMs(text: string, wpm: number, from = 0): number {
  if (wpm <= 0 || text.length <= 1 || from >= text.length - 1) return 0;
  const baseMs = 12000 / wpm;
  let total = 0;
  const limit = text.length - 1;
  for (let i = Math.max(0, from); i < limit; i += 1) {
    const ch = text[i];
    let ms = baseMs;
    if (ch === '\n') ms *= 2;
    else if (ch === '.' || ch === '!' || ch === '?') ms *= 1.5;
    total += Math.max(8, Math.round(ms));
  }
  return total;
}

export function formatHidTime(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${secs}s`;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

const STD_BOILERPLATE_STRUCTS = new Set(['ListNode', 'TreeNode', 'Node']);

export function buildHidPayload(
  source: string,
  scope: HidScope,
  indent: HidIndent,
): { text: string; map: number[] } {
  const spans = scope === 'functions' ? logicSpans(source) : [[0, source.length] as const];
  const map: number[] = [];
  let text = '';
  spans.forEach((span, index) => {
    if (index > 0 && text.length > 0 && !text.endsWith('\n')) {
      const gap = source.indexOf('\n', span[0] - 1);
      const nl = gap >= span[0] ? gap : source.lastIndexOf('\n', span[0]);
      if (nl >= 0) {
        text += '\n';
        map.push(nl);
      }
    }
    const piece = takeSpan(source, span[0], span[1], indent);
    text += piece.text;
    map.push(...piece.map);
  });
  return { text, map };
}

function takeSpan(source: string, start: number, end: number, indent: HidIndent): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let lineStart = start === 0 || source[start - 1] === '\n';
  for (let i = start; i < end && i < source.length; i += 1) {
    const ch = source[i];
    if (indent === 'strip' && lineStart && (ch === ' ' || ch === '\t')) continue;
    lineStart = ch === '\n';
    text += ch;
    map.push(i);
  }
  return { text, map };
}

type TopItem =
  | { kind: 'include' | 'using_ns' | 'main'; start: number; end: number }
  | {
      kind: 'class' | 'struct';
      name: string;
      start: number;
      end: number;
      bodyStart: number;
      bodyEnd: number;
    }
  | { kind: 'logic'; start: number; end: number };

/**
 * Extracts all logic-related code outside the file wrapper (`#include`, `using namespace std;`, `main()`):
 * - Keeps `#define` macros, `typedef` / `using` type aliases, `const` / `constexpr` / global variables,
 *   helper structs/classes, and helper functions.
 * - If a solution class is present (e.g. `class Solution { ... };` or `class LRUCache { ... };`),
 *   unwraps its outer `class Name { ... };` shell and includes everything inside its body
 *   (member variables, nested types, `public:` / `private:` labels, constructors, and methods).
 */
function logicSpans(source: string): Array<readonly [number, number]> {
  const items = parseTopLevelItems(source);
  const classItems = items.filter(
    (item): item is Extract<TopItem, { kind: 'class' | 'struct' }> => item.kind === 'class',
  );
  const unwrapTarget =
    classItems.find((item) => item.name === 'Solution') ??
    (classItems.length > 0 ? classItems[classItems.length - 1] : null);

  const spans: Array<[number, number]> = [];
  for (const item of items) {
    if (item.kind === 'include' || item.kind === 'using_ns' || item.kind === 'main') {
      continue;
    }
    if (item.kind === 'struct' && STD_BOILERPLATE_STRUCTS.has(item.name) && unwrapTarget) {
      continue;
    }
    if (unwrapTarget && item === unwrapTarget) {
      const inner = trimInnerBlock(source, item.bodyStart, item.bodyEnd);
      if (inner[1] > inner[0]) spans.push(inner);
      continue;
    }
    const trimmed = trimBlankLines(source, item.start, item.end);
    if (trimmed[1] > trimmed[0]) spans.push(trimmed);
  }
  return mergeAdjacentSpans(source, spans);
}

function parseTopLevelItems(source: string): TopItem[] {
  const items: TopItem[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    while (i < n && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r' || source[i] === '\n')) {
      i += 1;
    }
    if (i >= n) break;

    const noise = skipNoise(source, i);
    if (noise > i) {
      i = noise;
      continue;
    }

    const lineStart = findLineStart(source, i);

    if (source[i] === '#') {
      let end = i;
      while (end < n) {
        const nl = source.indexOf('\n', end);
        if (nl < 0) {
          end = n;
          break;
        }
        const prev = nl > 0 && source[nl - 1] === '\r' ? nl - 2 : nl - 1;
        end = nl + 1;
        if (prev < i || source[prev] !== '\\') break;
      }
      const directive = /^#\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i, end));
      const word = directive ? directive[1] : '';
      if (word === 'include' || word === 'pragma') {
        items.push({ kind: 'include', start: lineStart, end });
      } else {
        items.push({ kind: 'logic', start: lineStart, end });
      }
      i = end;
      continue;
    }

    const stmt = scanTopStatement(source, i);
    const slice = source.slice(i, stmt.end).trim();

    if (/^using\s+namespace\s+[A-Za-z0-9_:]+\s*;/.test(slice)) {
      items.push({ kind: 'using_ns', start: lineStart, end: stmt.end });
      i = stmt.end;
      continue;
    }

    if (stmt.classInfo) {
      items.push({
        kind: stmt.classInfo.kind,
        name: stmt.classInfo.name,
        start: lineStart,
        end: stmt.end,
        bodyStart: stmt.classInfo.openBrace + 1,
        bodyEnd: stmt.classInfo.closeBrace,
      });
      i = stmt.end;
      continue;
    }

    if (stmt.isMain) {
      items.push({ kind: 'main', start: lineStart, end: stmt.end });
      i = stmt.end;
      continue;
    }

    items.push({ kind: 'logic', start: lineStart, end: stmt.end });
    i = stmt.end;
  }

  return items;
}

function scanTopStatement(
  source: string,
  start: number,
): {
  end: number;
  isMain: boolean;
  classInfo: { kind: 'class' | 'struct'; name: string; openBrace: number; closeBrace: number } | null;
} {
  const n = source.length;
  let i = start;
  let firstWords: Array<{ word: string; at: number }> = [];
  let sawParenBeforeBrace = false;
  let isMain = false;

  while (i < n) {
    const noise = skipNoise(source, i);
    if (noise > i) {
      i = noise;
      continue;
    }
    const ch = source[i];
    if (ch === ';') {
      return { end: skipTrailingLineSpace(source, i + 1), isMain: false, classInfo: null };
    }
    if (ch === '(') {
      sawParenBeforeBrace = true;
      const prevWord = firstWords[firstWords.length - 1];
      if (prevWord && prevWord.word === 'main') {
        isMain = true;
      }
      const close = match(source, i, '(', ')');
      if (close < 0) return { end: n, isMain, classInfo: null };
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      const close = match(source, i, '{', '}');
      if (close < 0) return { end: n, isMain, classInfo: null };
      if (!sawParenBeforeBrace) {
        const classWordIdx = firstWords.findIndex((w) => w.word === 'class' || w.word === 'struct');
        if (classWordIdx >= 0) {
          const kind = firstWords[classWordIdx].word as 'class' | 'struct';
          const nameWord = firstWords[classWordIdx + 1];
          const name = nameWord ? nameWord.word : '';
          let afterClose = skipSpace(source, close + 1);
          while (afterClose < n && source[afterClose] !== ';') {
            const nextNoise = skipNoise(source, afterClose);
            if (nextNoise > afterClose) {
              afterClose = nextNoise;
              continue;
            }
            if (source[afterClose] === '\n') break;
            afterClose += 1;
          }
          const endPos =
            afterClose < n && source[afterClose] === ';'
              ? skipTrailingLineSpace(source, afterClose + 1)
              : skipTrailingLineSpace(source, close + 1);
          return {
            end: endPos,
            isMain: false,
            classInfo: { kind, name, openBrace: i, closeBrace: close },
          };
        }
      }
      let after = close + 1;
      while (after < n && (source[after] === ' ' || source[after] === '\t')) after += 1;
      if (source[after] === ';') {
        return { end: skipTrailingLineSpace(source, after + 1), isMain, classInfo: null };
      }
      return { end: skipTrailingLineSpace(source, close + 1), isMain, classInfo: null };
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j += 1;
      firstWords.push({ word: source.slice(i, j), at: i });
      i = j;
      continue;
    }
    i += 1;
  }

  return { end: n, isMain, classInfo: null };
}

function findLineStart(source: string, index: number): number {
  let i = index;
  while (i > 0 && (source[i - 1] === ' ' || source[i - 1] === '\t')) i -= 1;
  return i;
}

function skipTrailingLineSpace(source: string, index: number): number {
  let i = index;
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r')) i += 1;
  if (i < source.length && source[i] === '\n') return i + 1;
  return i;
}

function trimInnerBlock(source: string, start: number, end: number): [number, number] {
  let s = start;
  while (s < end && (source[s] === ' ' || source[s] === '\t' || source[s] === '\r')) s += 1;
  if (s < end && source[s] === '\n') s += 1;
  return trimBlankLines(source, s, end);
}

function trimBlankLines(source: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e) {
    let lineEnd = s;
    while (lineEnd < e && (source[lineEnd] === ' ' || source[lineEnd] === '\t' || source[lineEnd] === '\r')) {
      lineEnd += 1;
    }
    if (lineEnd < e && source[lineEnd] === '\n') {
      s = lineEnd + 1;
      continue;
    }
    break;
  }
  while (e > s && (source[e - 1] === ' ' || source[e - 1] === '\t' || source[e - 1] === '\r' || source[e - 1] === '\n')) {
    e -= 1;
  }
  if (e < source.length && source[e] === '\n') e += 1;
  return [s, e];
}

function mergeAdjacentSpans(
  source: string,
  spans: Array<[number, number]>,
): Array<readonly [number, number]> {
  if (spans.length <= 1) return spans;
  const merged: Array<[number, number]> = [spans[0]];
  for (let i = 1; i < spans.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = spans[i];
    const between = source.slice(prev[1], curr[0]);
    if (/^\s*$/.test(between)) {
      prev[1] = curr[1];
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

function match(source: string, openAt: number, open: string, close: string): number {
  let depth = 0;
  let i = openAt;
  while (i < source.length) {
    const noise = skipNoise(source, i);
    if (noise > i) {
      i = noise;
      continue;
    }
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipSpace(source: string, index: number): number {
  let i = index;
  while (i < source.length) {
    const noise = skipNoise(source, i);
    if (noise === i && source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\n' && source[i] !== '\r') break;
    i = Math.max(noise, i + 1);
    if (noise === i) break;
  }
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i += 1;
  return i;
}

function skipNoise(source: string, index: number): number {
  const ch = source[index];
  const next = source[index + 1];
  if (ch === '/' && next === '/') {
    let i = index + 2;
    while (i < source.length && source[i] !== '\n') i += 1;
    return i;
  }
  if (ch === '/' && next === '*') {
    const end = source.indexOf('*/', index + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let i = index + 1;
    while (i < source.length && source[i] !== ch) {
      if (source[i] === '\\') i += 2;
      else i += 1;
    }
    return Math.min(source.length, i + 1);
  }
  return index;
}

function isIdentStart(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z_]/.test(ch));
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
