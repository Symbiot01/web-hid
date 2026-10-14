/** Characters of `source` that will be typed, in order, and their indexes in `source`. */

export type HidScope = 'file' | 'functions';
export type HidIndent = 'keep' | 'strip';

export type HidPlay = { sent: number; map: number[]; eta: string };

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

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);

export function buildHidPayload(
  source: string,
  scope: HidScope,
  indent: HidIndent,
): { text: string; map: number[] } {
  const spans = scope === 'functions' ? functionSpans(source) : [[0, source.length] as const];
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

function functionSpans(source: string): Array<readonly [number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < source.length) {
    const noise = skipNoise(source, i);
    if (noise > i) {
      i = noise;
      continue;
    }
    if (!isIdentStart(source[i])) {
      i += 1;
      continue;
    }
    const nameStart = i;
    let j = i + 1;
    while (j < source.length && isIdentPart(source[j])) j += 1;
    const name = source.slice(nameStart, j);
    const after = skipSpace(source, j);
    if (source[after] !== '(' || CONTROL.has(name)) {
      i = j;
      continue;
    }
    const closeParen = match(source, after, '(', ')');
    if (closeParen < 0) {
      i = j;
      continue;
    }
    const brace = findBodyBrace(source, closeParen + 1);
    if (brace < 0) {
      i = j;
      continue;
    }
    const end = match(source, brace, '{', '}');
    if (end < 0) {
      i = j;
      continue;
    }
    if (name !== 'main') {
      spans.push([declarationStart(source, nameStart), end + 1]);
    }
    i = end + 1;
  }
  return spans;
}

function declarationStart(source: string, nameStart: number): number {
  let i = nameStart;
  while (i > 0) {
    let p = i - 1;
    while (p > 0 && (source[p] === ' ' || source[p] === '\t')) p -= 1;
    const ch = source[p];
    if (ch === '\n') {
      let q = p - 1;
      while (q > 0 && (source[q] === ' ' || source[q] === '\t' || source[q] === '\r')) q -= 1;
      const prev = source[q];
      if (prev === undefined || prev === ';' || prev === '{' || prev === '}' || prev === ':') {
        return skipLabel(source, p + 1);
      }
      i = q + 1;
      continue;
    }
    if (ch === ';' || ch === '{' || ch === '}') return skipLabel(source, p + 1);
    i = p;
  }
  return 0;
}

function skipLabel(source: string, index: number): number {
  let j = skipSpace(source, index);
  const label = /^(?:public|private|protected)\s*:/.exec(source.slice(j));
  if (!label) return j;
  return skipSpace(source, j + label[0].length);
}

function findBodyBrace(source: string, index: number): number {
  let i = index;
  while (i < source.length) {
    const noise = skipNoise(source, i);
    if (noise > i) {
      i = noise;
      continue;
    }
    const ch = source[i];
    if (ch === '{') return i;
    if (ch === ';') return -1;
    if (ch === '(') {
      const close = match(source, i, '(', ')');
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return -1;
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
