'use strict';

const MODEL = 'gemini-4-argon';
const MAX_APPROACHES = 3;
const MAX_COMPILE_FIXES = 3;
const CASE_LIMIT = 12;
const TEXT_LIMIT = 8_000;
const SOURCE_LIMIT = 64 * 1024;
const IMAGE_MAX = 4 * 1024 * 1024;
const MAX_IMAGES = 6;
const OUTPUT_LIMIT = 12_000;
const THINKING_LIMIT = 6_000;
const THOUGHT_LOG_LIMIT = 16;
const DRAFT_PREVIEW_LIMIT = 2_400;

const THINK_LABELS = {
  identify: 'reading the problem',
  review: 'checking cases',
  makeCases: 'writing cases',
  harness: 'writing the wrapper',
  solve: 'solving',
  retry: 'trying another approach',
  fix: 'repairing the code',
  ask: 'answering',
};

function extractDraftPreview(rawJson) {
  if (typeof rawJson !== 'string' || !rawJson) return '';
  const fieldMatch = /"(?:source|statement|text|reason)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(rawJson);
  if (!fieldMatch || !fieldMatch[1]) return '';
  const decoded = fieldMatch[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '  ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
  return decoded.length > DRAFT_PREVIEW_LIMIT
    ? decoded.slice(decoded.length - DRAFT_PREVIEW_LIMIT)
    : decoded;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function clip(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? text.slice(0, max) : text;
}

function redact(text, secret) {
  const value = typeof text === 'string' ? text : '';
  if (!secret || secret.length < 8) return value;
  return value.split(secret).join('[redacted]');
}

const RESERVED_ENTRY = new Set([
  'main',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'return',
  'int',
  'void',
  'double',
  'float',
  'long',
  'char',
  'bool',
  'auto',
  'class',
  'struct',
  'sizeof',
  'catch',
]);

function entryFunction(name) {
  if (typeof name !== 'string') return 'solve';
  const trimmed = name.trim().replace(/\s*\(.*$/, '');
  const member = trimmed.includes('::') ? trimmed.split('::').pop().trim() : trimmed;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,64}$/.test(member) || RESERVED_ENTRY.has(member)) return 'solve';
  return member;
}

function sanitizeTextField(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function sanitizeCaseItem(item) {
  if (!item || typeof item !== 'object') return { input: '', expected: '' };
  return {
    ...item,
    input: sanitizeTextField(item.input),
    expected: sanitizeTextField(item.expected),
  };
}

function entrySignature(entry, rawSignature) {
  const name = entryFunction(entry);
  if (name === 'solve') return 'void solve()';
  const cleaned = clip(rawSignature, 300)
    .replace(/\}\s*\{[\s\S]*$/, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return cleaned || `${name}(...)`;
}

function wantsMoreCases(text, action) {
  if (action === 'more_cases') return true;
  if (typeof text !== 'string' || !text.trim()) return false;
  return (
    /\b(add|more|extra|additional|new|generate|create|thorough|edge)\b[\s\S]{0,60}\b(test\s*cases?|cases?|tests?|edge\s*cases?)\b/i.test(
      text,
    ) ||
    /\b(test\s*cases?|cases?|edge\s*cases?)\b[\s\S]{0,40}\b(from\s+your\s+side|more|thorough|extra|additional)\b/i.test(
      text,
    )
  );
}

function stripCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < code.length && code[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < code.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < code.length) {
          out += '  ';
          i += 2;
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < code.length) {
        out += ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractFunctionBody(cleanCode, fnName) {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?(?:noexcept\\s*)?\\{`, 'g');
  let match;
  while ((match = pattern.exec(cleanCode)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    let depth = 1;
    let idx = openBrace + 1;
    while (idx < cleanCode.length && depth > 0) {
      if (cleanCode[idx] === '{') depth += 1;
      else if (cleanCode[idx] === '}') depth -= 1;
      idx += 1;
    }
    if (depth === 0) {
      return {
        start: match.index,
        openBrace,
        end: idx,
        body: cleanCode.slice(openBrace + 1, idx - 1),
      };
    }
  }
  return null;
}

function sourceHasEntry(source, entry) {
  const name = entryFunction(entry);
  const raw = typeof source === 'string' ? source : '';
  const clean = stripCommentsAndStrings(raw);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mainFn = extractFunctionBody(clean, 'main');
  if (!mainFn) {
    return new RegExp(`\\b${escaped}\\b`).test(clean) && /\bmain\b/.test(clean);
  }
  const outsideMain = `${clean.slice(0, mainFn.start)}\n${clean.slice(mainFn.end)}`;
  const isClassOrStruct = new RegExp(`\\b(?:class|struct)\\s+${escaped}\\b`).test(outsideMain);
  if (isClassOrStruct) {
    const usedInMain = new RegExp(`\\b${escaped}\\b`).test(mainFn.body);
    return usedInMain;
  }
  const entryFn = extractFunctionBody(outsideMain, name);
  if (!entryFn) {
    return new RegExp(`\\b${escaped}\\s*\\(`).test(outsideMain);
  }
  const callRegex = new RegExp(`\\b${escaped}\\s*\\(`);
  if (!callRegex.test(mainFn.body) && !callRegex.test(outsideMain.slice(entryFn.end))) {
    return false;
  }
  return true;
}

function cleanSource(source) {
  if (typeof source !== 'string') return '';
  const normalized = source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .replace(/^```(?:[a-zA-Z0-9_+-]*)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!normalized) return '';
  if (!normalized.includes('\n') && normalized.includes('\\n')) {
    const unescaped = normalized.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    return cleanSource(unescaped);
  }
  const withoutBoilerplate = normalized
    .replace(/[ \t]*(?:std::)?ios(?:_base)?::sync_with_stdio\s*\([^;]*\)\s*;[ \t]*\n?/g, '')
    .replace(/[ \t]*(?:std::)?c(?:in|out)\.tie\s*\([^;]*\)\s*;[ \t]*\n?/g, '')
    .replace(/^[ \t]*[A-Za-z_][A-Za-z0-9_]*\.reserve\s*\([^;]*\)\s*;[ \t]*\n?/gm, '')
    .replace(/\bif\s*\(\s*!\s*\(\s*(cin\s*>>[^;()]+?)\s*\)\s*\)\s*return(?:\s+0)?\s*;/g, '$1;')
    .trim();
  if (!withoutBoilerplate) return '';
  const lines = withoutBoilerplate.split('\n');
  const suspicious = lines.some(
    (line) =>
      (line.match(/\{/g) || []).length >= 2 ||
      (line.length > 100 && line.includes(';') && line.includes('{')),
  );
  if (!suspicious) return `${withoutBoilerplate}\n`;

  let out = '';
  let indent = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;

  for (let i = 0; i < withoutBoilerplate.length; i += 1) {
    const ch = withoutBoilerplate[i];
    const next = withoutBoilerplate[i + 1];
    if (inLineComment) {
      out += ch;
      if (ch === '\n') {
        inLineComment = false;
        out += '  '.repeat(Math.max(0, indent));
      }
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += '/';
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < withoutBoilerplate.length) {
        out += withoutBoilerplate[i + 1];
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      out += '//';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '/*';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;

    if (ch === '{' && parenDepth === 0) {
      out = out.replace(/[ \t]+$/, '');
      if (!out.endsWith('\n') && !out.endsWith(' ')) out += ' ';
      out += '{\n';
      indent += 1;
      while (withoutBoilerplate[i + 1] === ' ' || withoutBoilerplate[i + 1] === '\t') i += 1;
      if (withoutBoilerplate[i + 1] === '\n') i += 1;
      out += '  '.repeat(Math.max(0, indent));
      continue;
    }
    if (ch === '}' && parenDepth === 0) {
      indent = Math.max(0, indent - 1);
      out = out.replace(/[ \t]+$/, '');
      if (!out.endsWith('\n')) out += '\n';
      out += `${'  '.repeat(indent)}}`;
      if (withoutBoilerplate[i + 1] === ';') {
        out += ';';
        i += 1;
      }
      out += '\n';
      while (withoutBoilerplate[i + 1] === ' ' || withoutBoilerplate[i + 1] === '\t') i += 1;
      if (withoutBoilerplate[i + 1] === '\n') i += 1;
      out += '  '.repeat(Math.max(0, indent));
      continue;
    }
    if (ch === ';' && parenDepth === 0) {
      out += ';';
      let look = i + 1;
      while (withoutBoilerplate[look] === ' ' || withoutBoilerplate[look] === '\t') look += 1;
      if (withoutBoilerplate[look] && withoutBoilerplate[look] !== '\n' && withoutBoilerplate[look] !== '}' && withoutBoilerplate[look] !== '/') {
        out += `\n${'  '.repeat(Math.max(0, indent))}`;
        i = look - 1;
      }
      continue;
    }
    if (ch === '\n') {
      out = out.replace(/[ \t]+$/, '');
      out += '\n';
      while (withoutBoilerplate[i + 1] === ' ' || withoutBoilerplate[i + 1] === '\t') i += 1;
      const upcomingClose = withoutBoilerplate[i + 1] === '}';
      out += '  '.repeat(Math.max(0, upcomingClose ? indent - 1 : indent));
      continue;
    }
    if (ch === '\\' && next === 'n' && !inString && !inLineComment && !inBlockComment) {
      out = out.replace(/[ \t]+$/, '');
      out += '\n';
      i += 1;
      while (withoutBoilerplate[i + 1] === ' ' || withoutBoilerplate[i + 1] === '\t') i += 1;
      const upcomingClose = withoutBoilerplate[i + 1] === '}';
      out += '  '.repeat(Math.max(0, upcomingClose ? indent - 1 : indent));
      continue;
    }
    out += ch;
  }
  return `${out.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function hasHardcodedCases(source, cases) {
  if (typeof source !== 'string' || !Array.isArray(cases) || cases.length === 0) return false;
  const escapedLiteral = (val) => val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const item of cases) {
    if (!item || typeof item.input !== 'string' || typeof item.expected !== 'string') continue;
    const expected = item.expected.trim();
    const tokens = item.input
      .trim()
      .split(/\s+/)
      .filter((tok) => tok.length >= 3 && !/^-?[012]$/.test(tok));
    if (expected.length >= 3 && !/^-?[01]$/.test(expected) && !/^(YES|NO|true|false)$/i.test(expected)) {
      const expRegex = new RegExp(`["']${escapedLiteral(expected)}(?:\\\\n)?["']`);
      if (expRegex.test(source)) return true;
    }
    for (const tok of tokens) {
      if (tok.length >= 4 && /^[a-zA-Z0-9_-]+$/.test(tok)) {
        const condRegex = new RegExp(`if\\s*\\([^)]*==\\s*["']?${escapedLiteral(tok)}["']?`);
        if (condRegex.test(source)) return true;
      }
    }
  }
  return false;
}

function validSource(source, secret) {
  if (typeof source !== 'string' || source.length === 0 || source.length > SOURCE_LIMIT) return false;
  if (source.includes('\0') || !source.includes('main')) return false;
  if (secret && source.includes(secret)) return false;
  return true;
}

function validCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > CASE_LIMIT) return false;
  return cases.every(
    (item) =>
      item &&
      typeof item.input === 'string' &&
      typeof item.expected === 'string' &&
      item.input.length <= TEXT_LIMIT &&
      item.expected.length <= TEXT_LIMIT &&
      !item.input.includes('\0') &&
      !item.expected.includes('\0'),
  );
}

function imageOk(image) {
  if (!image) return true;
  if (!image || typeof image.data !== 'string' || !IMAGE_TYPES.has(image.mime)) return false;
  let bytes;
  try {
    bytes = Buffer.from(image.data, 'base64');
  } catch {
    return false;
  }
  if (bytes.length === 0 || bytes.length > IMAGE_MAX) return false;
  if (image.mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (image.mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50;
  return bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP';
}

function normalizeImages(input) {
  const list = [];
  if (input && Array.isArray(input.images)) {
    for (const item of input.images) {
      if (item) list.push(item);
    }
  } else if (input && input.image) {
    list.push(input.image);
  }
  if (list.length > MAX_IMAGES) return { ok: false, images: [] };
  for (const item of list) {
    if (!imageOk(item)) return { ok: false, images: [] };
  }
  return { ok: true, images: list };
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  const candidates = [];
  const stripped = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  candidates.push(stripped);
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(raw)) !== null) {
    if (fenceMatch[1]) candidates.push(fenceMatch[1].trim());
  }
  for (const item of candidates) {
    const start = item.indexOf('{');
    const end = item.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    const slice = item.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      try {
        const repaired = slice.replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // try next candidate
      }
    }
  }
  const error = new Error('The model reply was not usable');
  error.status = 502;
  throw error;
}

function schemaFor(task) {
  if (task === 'identify') {
    return {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        statement: { type: 'STRING' },
        casesFromProblem: { type: 'BOOLEAN' },
        cases: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              input: { type: 'STRING' },
              expected: { type: 'STRING' },
            },
            required: ['input', 'expected'],
          },
        },
        plan: { type: 'STRING' },
        functionName: { type: 'STRING' },
        signature: { type: 'STRING' },
        format: { type: 'STRING' },
      },
      required: ['statement', 'casesFromProblem', 'cases', 'plan', 'functionName', 'format'],
    };
  }
  if (task === 'review') {
    return {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN' },
        reason: { type: 'STRING' },
        cases: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              input: { type: 'STRING' },
              expected: { type: 'STRING' },
            },
            required: ['input', 'expected'],
          },
        },
      },
      required: ['ok', 'reason'],
    };
  }
  if (task === 'makeCases') {
    return {
      type: 'OBJECT',
      properties: {
        cases: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              input: { type: 'STRING' },
              expected: { type: 'STRING' },
            },
            required: ['input', 'expected'],
          },
        },
      },
      required: ['cases'],
    };
  }
  if (task === 'harness' || task === 'fix') {
    return {
      type: 'OBJECT',
      properties: {
        source: { type: 'STRING' },
      },
      required: ['source'],
    };
  }
  if (task === 'solve' || task === 'retry') {
    return {
      type: 'OBJECT',
      properties: {
        source: { type: 'STRING' },
        approach: { type: 'STRING' },
      },
      required: ['source', 'approach'],
    };
  }
  return {
    type: 'OBJECT',
    properties: {
      text: { type: 'STRING' },
    },
    required: ['text'],
  };
}

function promptFor(task, context) {
  const statement = clip(context.statement, 12_000);
  const cases = JSON.stringify(context.cases || [], null, 2).slice(0, 20_000);
  const hint = clip(context.hint, 4_000);
  const source = clip(context.source, 24_000);
  const failure = clip(context.failure, 6_000);
  const entry = entryFunction(context.entry);
  const signature = entrySignature(entry, context.signature);
  const format = clip(context.format, 1_000) || 'Match the exact input and expected output text in Cases.';

  if (task === 'identify') {
    const prior = statement
      ? `\n\nExisting problem context (combine with the new image(s)/text):\n${statement}\n\nExisting cases:\n${cases}`
      : '';
    return {
      system: [
        'You summarize programming problems from text or screenshots into your own concise technical specification.',
        'IMPORTANT: Never transcribe or copy problem story text verbatim from screenshots (verbatim copying triggers recitation filters). Always paraphrase and synthesize the mathematical/algorithmic problem specification in your own words.',
        'If multiple images/screenshots are provided, they show different parts of the SAME problem (description, examples, constraints, starter code template). Combine all images and any existing context into one specification.',
        'Reply with JSON only: {"title":"","statement":"","casesFromProblem":false,"cases":[{"input":"","expected":""}],"plan":"","functionName":"","signature":"","format":""}.',
        '- title: short problem title (e.g. "Median of Two Sorted Arrays", "Shortest Routes I").',
        '- statement: concise, paraphrased technical problem specification in your own words (what is given, what operations/rules apply, what to return/print, and exact numeric constraints). If a starter code template or class/function stub is shown in the prompt, screenshot, or editor, include that C++ signature.',
        '- casesFromProblem / cases: extract all sample inputs and outputs across all provided screenshots/context ONLY when shown in the problem. If none are shown, set casesFromProblem to false and cases to []. Never guess or invent sample outputs here.',
        '- Agentic Bare-Bones Competitive Programming Format (MANDATORY):',
        '  * Convert every sample `input` and `expected` output into clean, bare-bones competitive programming stdin/stdout so `cin >>` can read it directly without string/bracket parsing. Use real JSON newline escapes (`\\n`), never double-escaped `\\\\n`.',
        '  * 1D Arrays & Scalars: Strip variable labels (`arr[] =`, `nums1 =`, `target =`, `s =`), brackets `[...]`, `{...}`, quotes `"..."`, and commas. Prefix every 1D array with its length `n` on a line followed by `n` space-separated elements on the next line (unless `n` is already given immediately before it). Example: `arr[] = [1, 2, 3, 4, 5]` -> `"5\\n1 2 3 4 5\\n"`; `nums = [2,7,11,15], target = 9` -> `"4\\n2 7 11 15\\n9\\n"`.',
        '  * 2D Arrays / Grids: Convert `[[1,2,3],[4,5,6]]` into `"2 3\\n1 2 3\\n4 5 6\\n"` (`rows cols` followed by each row).',
        '  * Query / Class-Design Problems (e.g. `["LRUCache", "put", "get"]` with `[[2], [1, 1], [1]]`, or `RandomizedCollection`, `Trie`, `MinStack`): Convert the parallel command/argument arrays into bare-bones query lines: Line 1 is constructor argument(s) (if any) and operation count `q` (or `q` on Line 1 if no constructor args), followed by `q` lines of `op arg1 arg2...`. Omit `null` constructor/void outputs in `expected` and include only non-void query return values separated by spaces or newlines (and state that exact convention in `format`).',
        '  * Expected Outputs: Strip outer `[` `]`, quotes, and commas into bare space- or newline-separated tokens (e.g. `[0, 1]` -> `"0 1\\n"`).',
        '- Template vs. Standard Competitive Programming rule:',
        '  1. IF a starter template function or class signature is given in the problem or screenshot (other than a bare `int main()` skeleton — e.g. LeetCode/HackerRank `class Solution` with `findMedianSortedArrays`, a standalone function like `int trap(vector<int>& height)`, or an OOP design class like `class LRUCache`): conform strictly to that template — set `functionName` to that exact method, function, or class name and `signature` to its clean C++17 signature only.',
        '  2. OTHERWISE (standard stdin/stdout competitive programming like Codeforces, AtCoder, CSES, ICPC, no template given, or only a bare `int main() { ... }` starter skeleton is given): ALWAYS set `functionName` to `"solve"` and `signature` to `"void solve()"` (never `void solve(istream&, ostream&)`). `void solve()` handles one test case reading directly from `cin` and writing directly to `cout`, while `main()` loops over test cases.',
        '- format: precise description of the bare-bones stdin token order and bare-bones stdout format used in `cases`.',
        '- plan: 1-2 sentences stating the optimal algorithm and its time and space complexity.',
      ].join('\n'),
      user: `Problem text:\n${clip(context.text, 12_000)}${prior}\n\nCurrent editor file:\n${source}`,
    };
  }
  if (task === 'review') {
    return {
      system: [
        'You verify sample test cases by hand against the problem statement. Do not write a program. Reply with JSON only: {"ok":true,"reason":"","cases":[{"input":"","expected":""}]}.',
        '- Note that Cases may be formatted in bare-bones competitive programming stdin/stdout (e.g. array size `n` followed by elements, or `q` lines of `op arg` queries without `null` for constructor).',
        '- If an operation is randomized (e.g. `getRandom()`) or the problem allows multiple valid answers ("return any valid..."), set `ok` to `true` as long as the expected output is a valid possible outcome.',
        '- Set `ok` to `false` ONLY when a sample expected output is mathematically impossible under the problem statement.',
        '- Whenever you set `ok` to `false`, also return `cases` containing the full list of cases with every incorrect `expected` output repaired to the exact mathematically valid answer.',
      ].join('\n'),
      user: `Statement:\n${statement}\n\nCases:\n${cases}`,
    };
  }
  if (task === 'makeCases') {
    const hasExisting = Array.isArray(context.cases) && context.cases.length > 0;
    return {
      system: [
        hasExisting
          ? 'Generate 3 to 4 NEW, thorough edge and stress test cases that are NOT duplicates of Existing cases.'
          : 'Generate 4 thorough bare-bones stdin/stdout test cases for this problem, covering a basic case, boundary/minimal case, tricky edge case, and stress pattern.',
        'Reply with JSON only: {"cases":[{"input":"","expected":""}]}.',
        'Mandatory test-case rules:',
        '1. Every `input` and `expected` string MUST strictly follow the bare-bones competitive programming stdin/stdout format described in Format and Existing cases (no variable labels `arr[] =`, no brackets `[...]`, no commas; prefix arrays with size `n` and write query problems as `q` lines of `op args...`).',
        '2. Cover diverse edge conditions: empty/single-element inputs, negative numbers, zeros, duplicates, odd vs even lengths, already-sorted vs reverse-sorted, and boundary values allowed by the statement.',
        '3. Trace the problem rules carefully by hand for each new input so every `expected` output is 100% mathematically correct.',
      ].join('\n'),
      user: `Statement:\n${statement}\n\nFormat:\n${format}\n\nExisting cases:\n${cases}\n\nFocus / user request:\n${hint || 'Add thorough edge, boundary, and corner cases.'}`,
    };
  }
  if (task === 'harness') {
    return {
      system: [
        'Write a clean, minimal, human-style C++17 test harness (`int main()`) and a compilable stub for the target function or class.',
        'Reply with JSON only: {"source":""}.',
        'Header & style rules (mandatory):',
        '- ALWAYS start with `#include <bits/stdc++.h>` and `using namespace std;` instead of listing multiple individual standard library headers.',
        '- NEVER write `ios_base::sync_with_stdio(false);` or `cin.tie(nullptr);`.',
        '- Write the simplest, cleanest C++17 code possible with 2-space indentation.',
        'Structure rules:',
        `- Mode A — Standard Competitive Programming (\`${entry}\` is \`solve\` and signature is \`void solve()\`):`,
        '  * Write `void solve() {}` above `main()` (it takes NO parameters — never `istream&` or `ostream&` — and solves a single test case using `cin` and `cout` directly).',
        '  * In `main()`, handle the test-case loop: if the input starts with the number of test cases `t`, write `long long t; cin >> t; while (t--) solve();`; if there is only 1 test case per input, write `long long t = 1; while (t--) solve();`. Never nest a test-case loop inside `solve()`.',
        `- Mode B — Template Function or Class Given (\`${signature}\` has parameters/return value or is a class like \`${entry}\`):`,
        `  * Include any required structs (\`ListNode\`, \`TreeNode\` if used in \`${signature}\`) and the exact function/class \`${signature}\` with minimal placeholder returns so it compiles.`,
        `  * Test cases are in bare-bones competitive programming stdin format (e.g. \`5\\n1 2 3 4 5\\n\` for arrays, or \`q\` lines of \`op args...\` for query/class problems). In \`main()\`, read inputs directly using simple \`cin >>\` statements (without \`if (!(cin >> ...))\` guards), call \`${entry}\` (or instantiate \`${entry}\` and dispatch queries), and print the bare result to \`cout\` matching Cases.`,
      ].join('\n'),
      user: `Statement:\n${statement}\n\nTarget function:\n${entry}\n\nSignature:\n${signature}\n\nSample format:\n${format}\n\nCases:\n${cases}`,
    };
  }
  if (task === 'solve' || task === 'retry') {
    return {
      system: [
        'Write the simplest, cleanest, optimal, natural human-style C++17 solution program.',
        'Reply with JSON only: {"source":"","approach":""}.',
        'Code style & structure rules (mandatory):',
        '1. Header & No Fast-I/O Boilerplate: ALWAYS use `#include <bits/stdc++.h>` and `using namespace std;` at the top. NEVER add `ios_base::sync_with_stdio(false);` or `cin.tie(nullptr);`.',
        '2. Template conformance vs. `void solve()` and test-case loop:',
        `   - If a specific function or class template was given (\`${signature}\` other than \`void solve()\`): conform strictly to that signature, put the algorithm inside \`${entry}\` (plus any top-level helper functions above it), and keep \`main()\` at the bottom strictly as the test wrapper that reads bare-bones \`cin\`, calls/dispatches \`${entry}\`, and prints to \`cout\`.`,
        '   - Otherwise (`void solve()`): `void solve()` solves ONE test case (reading that test case\'s inputs directly from `cin` and printing its output to `cout`). `main()` handles the test-case loop: use `long long t; cin >> t; while (t--) solve();` when the input begins with testcase count `t`, or `long long t = 1; while (t--) solve();` when there is only 1 test case per input. NEVER put the testcase loop inside `solve()` or create a `main() -> solve() -> solve_case()` chain.',
        '3. Natural Human C++ Conventions (strictly avoid AI tells):',
        '   - Top-level helper functions, NEVER local lambdas: NEVER write local lambdas inside `solve()` or the target function (especially never `auto fn = [&](...) -> bool { ... };` with trailing return types). Whenever a helper function (e.g. `check`, `can_reach`, `dfs`, `bfs`) is needed, write it as a normal top-level function above `solve()` / `' + entry + '`.',
        '   - Use `long long` everywhere: Use `long long` instead of `int` for all integer variables, loop counters, array sizes, capacities, weights, distances, helper function parameters/returns, and containers (`vector<long long>`, `pair<long long, long long>`), EXCEPT `int main()` and any fixed `int` types required by a given starter template signature.',
        '   - No `(int)` casts on `.size()`: NEVER write C-style casts like `(int)vec.size()`. Store sizes and bounds directly in `long long` variables (e.g. `long long high = weights.size() - 1;`).',
        '   - Direct `cin >>` reads: NEVER wrap initial input reads in `if (!(cin >> n >> m)) return;`. Simply declare variables and read with `cin >> n >> m;`.',
        '   - No `.reserve()`: NEVER call `.reserve(...)` on vectors.',
        '4. Cases use bare-bones whitespace-separated stdin (e.g. array size `n` followed by `n` space-separated elements `5\\n1 2 3 4 5\\n`, or constructor args + `q` lines of `op arg...` for query/class problems). Read inputs with simple `cin >>` in `main()` (for template functions/classes) or `solve()`, and print bare space/newline-separated output matching the exact `expected` strings in Cases. For strings that may be empty (`""`), use `getline(cin, s)` carefully so empty input does not fail `cin >> s`.',
        '5. Match the exact expected output format (`fixed << setprecision(...)`, `true`/`false`, `YES`/`NO`, or space/newline-separated answers).',
        '6. Format across multiple lines with 2-space indentation. Do not open files, spawn processes, or use the network. `approach` is 1-2 concise sentences stating the algorithm and time/space complexity.',
        '7. If `Previous result` shows failed test cases (`status: "wrong"` or `"tle"` or `"error"`), carefully inspect EVERY failed test case (`input`, `expected`, and `actual` output) to diagnose which missing edge case, boundary condition, integer overflow, or off-by-one bug caused the mismatch before writing the new solution.',
        '8. STRICT ANTI-CHEAT / NO HARDCODING RULE: NEVER hardcode specific test case inputs or expected outputs (e.g., NEVER write `if (n == 5 && data == "zzzzz") return ...;` or check for specific sample values). Every output must be computed purely by a general mathematical/algorithmic solution that works for all valid inputs up to the problem constraints.',
      ].join('\n'),
      user: `Statement:\n${statement}\n\nFunction:\n${entry}\n\nSignature:\n${signature}\n\nSample format:\n${format}\n\nCases:\n${cases}\n\nApproach:\n${hint || 'Use the simplest optimal algorithm that handles all constraints and edge cases.'}\n\nPrevious source:\n${source}\n\nPrevious result:\n${failure}`,
    };
  }
  if (task === 'fix') {
    return {
      system: [
        'Repair the C++17 program so it compiles cleanly and remains simple, natural, and readable.',
        'Reply with JSON only: {"source":""}.',
        '- Prefer `#include <bits/stdc++.h>` and `using namespace std;` at the top. Never add `ios_base::sync_with_stdio(false);` or `cin.tie(nullptr);`.',
        `- Keep all algorithm logic inside \`${entry}\` (and any top-level helper functions above it) above \`main()\`. If \`${entry}\` is \`solve\`, use \`void solve()\` for a single test case and keep the test-case loop (\`long long t = 1; while (t--) solve();\` or \`long long t; cin >> t; while (t--) solve();\`) in \`main()\`.`,
        '- Use top-level helper functions instead of local `[&]` lambdas, use `long long` for integer variables/containers, avoid `(int)vec.size()` casts, avoid `.reserve()`, and read with `cin >>` directly without `if (!(cin >> ...)) return;` guards.',
        '- NEVER hardcode specific test case inputs or expected outputs (no `if (input == ...)` branches for sample cases); always use the general algorithm.',
        '- Format the code cleanly across multiple lines with 2-space indentation.',
      ].join('\n'),
      user: `What is wrong:\n${failure}\n\nFunction:\n${entry}\n\nSignature:\n${signature}\n\nSample format:\n${format}\n\nCases:\n${cases}\n\nSource:\n${source}`,
    };
  }
  return {
    system: 'Answer the question about this C++ file clearly and concisely. Do not claim the file was edited. Reply with JSON only: {"text":""}.',
    user: `File:\n${source}\n\nQuestion:\n${clip(context.text, 4_000)}`,
  };
}

function takeModelPayload(payload, bucket, onThought, onVisible) {
  const candidate = payload && payload.candidates && payload.candidates[0];
  if (candidate && candidate.finishReason) bucket.finishReason = candidate.finishReason;
  const chunks = candidate && candidate.content ? candidate.content.parts || [] : [];
  for (const part of chunks) {
    if (!part || typeof part.text !== 'string' || !part.text) continue;
    if (part.thought) {
      bucket.thoughts += part.text;
      if (typeof onThought === 'function') onThought(part.text);
    } else {
      bucket.visible += part.text;
      if (typeof onVisible === 'function') onVisible(part.text, bucket.visible);
    }
  }
}

async function collectModelParts(response, onThought, onVisible) {
  const bucket = { visible: '', thoughts: '', finishReason: '' };
  const streamable = response.body && typeof response.body.getReader === 'function';
  if (!streamable) {
    takeModelPayload(await response.json(), bucket, onThought, onVisible);
    return bucket;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      takeModelPayload(JSON.parse(data), bucket, onThought, onVisible);
    } catch {
      // A split frame is completed on a later newline.
    }
  };
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let splitAt = buffer.indexOf('\n');
    while (splitAt !== -1) {
      consumeLine(buffer.slice(0, splitAt));
      buffer = buffer.slice(splitAt + 1);
      splitAt = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) consumeLine(buffer);
  return bucket;
}

function createGemini({ apiKey, model, fetchImpl, onThought, onProgress }) {
  const fetchFn = fetchImpl || fetch;
  const supportsThinkingLevel = /^gemini-[34]/i.test(String(model || MODEL));
  async function generate(task, context) {
    const built = promptFor(task, context);
    const parts = [{ text: built.user }];
    const imageList = Array.isArray(context.images)
      ? context.images
      : context.image
        ? [context.image]
        : [];
    for (const img of imageList) {
      if (img && img.mime && img.data) {
        parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
      }
    }
    const generationConfig = {
      temperature: task === 'solve' || task === 'retry' ? 0.25 : 0.1,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: schemaFor(task),
    };
    if (supportsThinkingLevel) {
      generationConfig.thinkingConfig = {
        thinkingLevel: 'HIGH',
        includeThoughts: true,
      };
    }
    const replyLabel = {
      identify: 'problem read',
      review: 'case check',
      makeCases: 'test-case',
      harness: 'test wrapper',
      solve: 'solution',
      retry: 'solution',
      fix: 'repair',
      ask: 'answer',
    }[task] || 'model';
    const failed = (reason) => {
      const error = new Error(
        reason === 'cut'
          ? `The ${replyLabel} reply was cut off before it finished.`
          : reason === 'http'
            ? 'The model request failed'
            : `The ${replyLabel} reply was not usable.`,
      );
      error.status = 502;
      return error;
    };
    let lastError = null;
    let sawRecitation = false;
    for (let tryNum = 0; tryNum < 3; tryNum += 1) {
      if (context && context.signal && context.signal.aborted) {
        const abortErr = new Error('Cancelled');
        abortErr.code = 'ABORTED';
        abortErr.status = 499;
        throw abortErr;
      }
      const config = { ...generationConfig };
      if (config.thinkingConfig) config.thinkingConfig = { thinkingLevel: 'HIGH', includeThoughts: true };
      if (sawRecitation) {
        config.temperature = Math.max(config.temperature || 0.2, 0.45);
      }
      if (tryNum === 2) {
        delete config.responseSchema;
      }
      const antiRecitationSuffix = sawRecitation
        ? '\n\nIMPORTANT: Do NOT quote or copy text verbatim from the problem or image. Paraphrase the problem specification and constraints completely in your own concise words and reply with one JSON object only.'
        : tryNum === 2
          ? '\n\nReply with one JSON object only.'
          : '';
      const userParts = antiRecitationSuffix
        ? [{ text: `${built.user}${antiRecitationSuffix}` }, ...parts.slice(1)]
        : parts;
      const stageLabel = (context && context.stageLabel) || THINK_LABELS[task] || 'working';
      if (typeof onThought === 'function') {
        onThought('', { reset: true, label: stageLabel, task });
      }
      if (typeof onProgress === 'function') {
        onProgress({ type: 'start', task, label: stageLabel, retry: tryNum });
      }
      let response;
      const timeoutSignal = AbortSignal.timeout(120_000);
      const reqSignal =
        context && context.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([timeoutSignal, context.signal])
          : timeoutSignal;
      try {
        response = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: built.system }] },
              contents: [{ role: 'user', parts: userParts }],
              generationConfig: config,
            }),
            signal: reqSignal,
          },
        );
      } catch (err) {
        if (context && context.signal && context.signal.aborted) {
          const abortErr = new Error('Cancelled');
          abortErr.code = 'ABORTED';
          abortErr.status = 499;
          throw abortErr;
        }
        lastError = err;
        continue;
      }
      if (!response.ok) {
        lastError = failed('http');
        if (response.status >= 500 || response.status === 429 || response.status === 400) continue;
        throw lastError;
      }
      try {
        const collected = await collectModelParts(
          response,
          (chunk) => {
            const cleanChunk = redact(chunk, apiKey);
            if (typeof onThought === 'function') onThought(cleanChunk);
            if (typeof onProgress === 'function') onProgress({ type: 'thought', task, text: cleanChunk });
          },
          (chunk, fullVisible) => {
            if (typeof onProgress === 'function') {
              onProgress({
                type: 'draft',
                task,
                delta: redact(chunk, apiKey),
                visible: redact(fullVisible, apiKey),
              });
            }
          },
        );
        if (collected.finishReason === 'RECITATION') sawRecitation = true;
        const text = collected.visible.trim() ? collected.visible : collected.thoughts;
        if (!text.trim() || collected.finishReason === 'MAX_TOKENS') {
          lastError = failed('cut');
          continue;
        }
        const parsed = parseModelJson(redact(text, apiKey));
        if (typeof onProgress === 'function') {
          onProgress({ type: 'done', task });
        }
        return parsed;
      } catch (err) {
        if (context && context.signal && context.signal.aborted) {
          const abortErr = new Error('Cancelled');
          abortErr.code = 'ABORTED';
          abortErr.status = 499;
          throw abortErr;
        }
        lastError = err && err.status ? err : failed('bad');
      }
    }
    if (typeof onProgress === 'function') {
      onProgress({ type: 'error', task });
    }
    const error = lastError && lastError.status ? lastError : failed('http');
    error.status = 502;
    throw error;
  }
  generate.supportsHarness = true;
  return generate;
}

function formatRun(result) {
  if (!result) return '';
  if (result.status === 'compile_error') {
    return `compile failed\n${clip(result.compile && result.compile.stderr, 2_000)}`;
  }
  return (result.cases || [])
    .map((item, index) => {
      const head = `case ${index + 1} ${item.status}${item.reason ? ` (${item.reason})` : ''}${typeof item.timeMs === 'number' ? ` ${item.timeMs}ms` : ''}`;
      if (item.status === 'pass') return head;
      const stderrLine = item.stderr && item.stderr.trim() ? `\nstderr: ${clip(item.stderr.trim(), 300)}` : '';
      return `${head}\ninput: ${clip(item.input, 300)}\nexpected: ${clip(item.expected, 400)}\nactual: ${clip(item.actual, 400)}${stderrLine}`;
    })
    .join('\n\n');
}

function createAgentControl({ apiKey, model, generate, run }) {
  const secret = apiKey || '';
  const listeners = new Set();
  let flushTimer = null;
  let thoughtSeq = 0;
  let activeAbort = null;
  let state;

  function notify(immediate = false) {
    if (listeners.size === 0) return;
    if (immediate) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const snap = snapshot();
      for (const listener of listeners) {
        try {
          listener(snap);
        } catch {
          // ignore listener error
        }
      }
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const snap = snapshot();
      for (const listener of listeners) {
        try {
          listener(snap);
        } catch {
          // ignore listener error
        }
      }
    }, 60);
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function currentLogEntry() {
    if (!state || !Array.isArray(state.thoughtLog) || state.thoughtLog.length === 0) return null;
    return state.thoughtLog[state.thoughtLog.length - 1];
  }

  function startLogEntry(task, label) {
    if (!state) return null;
    const prev = currentLogEntry();
    if (prev && (prev.status === 'thinking' || prev.status === 'drafting')) {
      prev.status = 'done';
      prev.elapsedMs = Math.max(0, Date.now() - prev.startedAt);
    }
    thoughtSeq += 1;
    const entry = {
      id: `thought-${thoughtSeq}`,
      task: clip(task || 'model', 32),
      label: clip(label || THINK_LABELS[task] || 'working', 80),
      text: '',
      draftChars: 0,
      draftPreview: '',
      startedAt: Date.now(),
      elapsedMs: 0,
      status: 'thinking',
    };
    state.thoughtLog.push(entry);
    if (state.thoughtLog.length > THOUGHT_LOG_LIMIT) {
      state.thoughtLog.splice(0, state.thoughtLog.length - THOUGHT_LOG_LIMIT);
    }
    state.thinking = '';
    state.thinkingLabel = entry.label;
    state.drafting = '';
    state.draftChars = 0;
    notify(true);
    return entry;
  }

  function finishLogEntry(status = 'done') {
    const entry = currentLogEntry();
    if (!entry) return;
    if (entry.status === 'thinking' || entry.status === 'drafting') {
      entry.status = status;
      entry.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
    }
    state.drafting = '';
    state.draftChars = 0;
    notify(true);
  }

  const thoughtSink = {
    fn(text, meta) {
      if (!state) return;
      if (meta && meta.reset) {
        state.thinking = '';
        state.thinkingLabel = clip(meta.label || '', 80);
        return;
      }
      const clean = redact(String(text || ''), secret).replace(/\0/g, '');
      if (!clean) return;
      const next = state.thinking + clean;
      state.thinking = next.length > THINKING_LIMIT ? next.slice(next.length - THINKING_LIMIT) : next;
      const entry = currentLogEntry();
      if (entry) {
        const entryNext = entry.text + clean;
        entry.text = entryNext.length > THINKING_LIMIT ? entryNext.slice(entryNext.length - THINKING_LIMIT) : entryNext;
        entry.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
      }
      notify(false);
    },
    progress(evt) {
      if (!state || !evt) return;
      if (evt.type === 'start') {
        const existing = currentLogEntry();
        if (!existing || existing.task !== evt.task || (existing.status !== 'thinking' && existing.status !== 'drafting')) {
          startLogEntry(evt.task, evt.label);
        } else if (evt.retry > 0) {
          existing.text = '';
          existing.draftChars = 0;
          existing.draftPreview = '';
          existing.status = 'thinking';
          notify(true);
        }
        return;
      }
      if (evt.type === 'draft') {
        const cleanVisible = redact(String(evt.visible || ''), secret).replace(/\0/g, '');
        const preview = redact(extractDraftPreview(cleanVisible), secret);
        state.draftChars = cleanVisible.length;
        if (preview) state.drafting = preview;
        const entry = currentLogEntry();
        if (entry) {
          entry.status = 'drafting';
          entry.draftChars = cleanVisible.length;
          if (preview) entry.draftPreview = preview;
          entry.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
        }
        notify(false);
        return;
      }
      if (evt.type === 'done') {
        finishLogEntry('done');
        return;
      }
      if (evt.type === 'error') {
        finishLogEntry('error');
      }
    },
  };

  const baseTalk =
    generate ||
    createGemini({
      apiKey: secret,
      model: model || MODEL,
      onThought: (text, meta) => thoughtSink.fn(text, meta),
      onProgress: (evt) => thoughtSink.progress(evt),
    });

  async function talk(task, context = {}) {
    const label = context.stageLabel || THINK_LABELS[task] || 'working';
    startLogEntry(task, label);
    try {
      const enriched =
        activeAbort && !context.signal ? { ...context, signal: activeAbort.signal } : context;
      const result = await baseTalk(task, enriched);
      finishLogEntry('done');
      return result;
    } catch (err) {
      finishLogEntry('error');
      throw err;
    }
  }
  talk.supportsHarness = Boolean(baseTalk && baseTalk.supportsHarness);

  state = {
    phase: 'idle',
    step: 'idle',
    attempt: 0,
    running: false,
    startedAt: null,
    elapsedMs: 0,
    title: '',
    statement: '',
    entry: 'solve',
    signature: '',
    format: '',
    casesFromProblem: false,
    casesVerified: false,
    cases: [],
    images: [],
    source: '',
    approach: '',
    hint: '',
    pendingHint: '',
    stopForCases: false,
    messages: [],
    output: '',
    failure: '',
    activity: '',
    thinking: '',
    thinkingLabel: '',
    drafting: '',
    draftChars: 0,
    thoughtLog: [],
  };

  function say(text, kind) {
    const clean = redact(clip(text, 4_000), secret);
    if (!clean) return;
    const messageKind = kind || 'step';
    state.messages.push({ role: 'assistant', text: clean, kind: messageKind });
    if (messageKind === 'step') state.activity = clean;
    if (state.messages.length > 40) state.messages.splice(0, state.messages.length - 40);
    notify(true);
  }

  function busy() {
    const error = new Error('Agent is already working');
    error.status = 409;
    error.view = snapshot();
    throw error;
  }

  function noteOutput(text) {
    state.output = clip(`${state.output}${text}\n`, OUTPUT_LIMIT);
    notify(false);
  }

  function snapshot() {
    const now = Date.now();
    return {
      configured: secret.length >= 20,
      phase: state.phase,
      step: state.step,
      attempt: state.attempt,
      maxAttempts: MAX_APPROACHES,
      title: state.title,
      entry: state.entry,
      signature: state.signature,
      format: state.format,
      messages: state.messages.map((item) => ({
        role: item.role,
        text: item.text,
        kind: item.kind || (item.role === 'user' ? 'user' : 'step'),
      })),
      source: state.source || null,
      cases: state.cases.map((item, index) => ({
        input: item.input,
        expected: item.expected,
        actual: item.actual || '',
        stderr: item.stderr || '',
        reason: item.reason || null,
        timeMs: typeof item.timeMs === 'number' ? item.timeMs : 0,
        status: item.status || 'idle',
        id: `agent-${index + 1}`,
      })),
      output: state.output,
      activity: state.activity,
      thinking: state.thinking,
      thinkingLabel: state.thinkingLabel,
      drafting: state.drafting || '',
      draftChars: state.draftChars || 0,
      startedAt: state.startedAt || null,
      elapsedMs:
        state.running && state.startedAt
          ? Math.max(0, now - state.startedAt)
          : state.elapsedMs || 0,
      thoughtLog: (state.thoughtLog || []).map((item) => ({
        id: item.id,
        task: item.task,
        label: item.label,
        text: item.text,
        draftChars: item.draftChars || 0,
        draftPreview: item.draftPreview || '',
        startedAt: item.startedAt,
        elapsedMs:
          item.status === 'thinking' || item.status === 'drafting'
            ? Math.max(0, now - item.startedAt)
            : item.elapsedMs,
        status: item.status,
      })),
      running: state.running,
    };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    if (listeners.size >= 16) {
      const oldest = listeners.values().next().value;
      if (oldest) listeners.delete(oldest);
    }
    listeners.add(listener);
    try {
      listener(snapshot());
    } catch {
      // ignore
    }
    return () => {
      listeners.delete(listener);
    };
  }

  function refuse(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  async function reviewCases() {
    const verdict = await talk('review', { statement: state.statement, cases: state.cases });
    const ok = verdict.ok === true;
    const reason = clip(verdict.reason, 1_000);
    const repairedCases = validCases(verdict.cases)
      ? verdict.cases.map((rawItem) => {
          const item = sanitizeCaseItem(rawItem);
          return {
            input: item.input,
            expected: item.expected,
            actual: '',
            stderr: '',
            reason: null,
            timeMs: 0,
            status: 'idle',
          };
        })
      : null;
    return { ok, reason, repairedCases };
  }

  async function buildHarnessIfSupported() {
    if (!talk.supportsHarness) return;
    state.step = 'harness';
    say(`Building the main() test wrapper around ${state.entry}() for the sample format.`);
    try {
      const wrapped = await talk('harness', {
        statement: state.statement,
        cases: state.cases,
        entry: state.entry,
        signature: state.signature,
        format: state.format,
      });
      const formatted = cleanSource(wrapped && wrapped.source);
      if (validSource(formatted, secret) && sourceHasEntry(formatted, state.entry)) {
        state.source = formatted;
        notify(true);
      }
    } catch {
      // If the optional harness pre-step fails, solve will generate both the wrapper and entry function.
    }
  }

  async function executeCurrentCases() {
    state.step = 'test';
    notify(true);
    let result;
    try {
      result = await run(state.source, state.cases);
    } catch (err) {
      state.phase = 'needs_human';
      const reason = err && err.code === 'BUSY' ? 'Another run is in progress.' : 'The runner could not start.';
      say(`${reason} The program is in the editor.`);
      return { ok: false, fatal: true };
    }
    if (!result || !result.status) {
      state.phase = 'needs_human';
      say('The runner could not start. The program is in the editor.');
      return { ok: false, fatal: true };
    }
    const ran = result.cases || [];
    state.cases = state.cases.map((item, index) => ({
      input: item.input,
      expected: item.expected,
      actual: ran[index] ? ran[index].actual : '',
      stderr: ran[index] && ran[index].stderr ? ran[index].stderr : '',
      reason: ran[index] && ran[index].reason ? ran[index].reason : null,
      timeMs: ran[index] && typeof ran[index].timeMs === 'number' ? ran[index].timeMs : 0,
      status: result.status === 'compile_error' ? 'idle' : ran[index] ? ran[index].status : 'idle',
    }));
    const report = formatRun({
      ...result,
      cases: state.cases.map((item, index) => ({ ...item, ...(ran[index] || {}) })),
    });
    noteOutput(report);
    state.failure = report;
    const passedCount = state.cases.filter((item) => item.status === 'pass').length;
    return {
      ok: result.status !== 'compile_error' && passedCount === state.cases.length,
      fatal: false,
      result,
      passedCount,
    };
  }

  async function addCasesAndTest(userHint) {
    state.step = 'cases';
    say('Generating additional edge and boundary test cases for this problem.');
    const made = await talk('makeCases', {
      statement: state.statement,
      format: state.format,
      cases: state.cases,
      hint: userHint,
    });
    if (!validCases(made && made.cases)) refuse(502, 'The model reply was not usable');
    const seen = new Set(state.cases.map((item) => item.input.trim()));
    const fresh = [];
    for (const rawItem of made.cases) {
      const item = sanitizeCaseItem(rawItem);
      const key = item.input.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push({
        input: item.input,
        expected: item.expected,
        actual: '',
        stderr: '',
        reason: null,
        timeMs: 0,
        status: 'idle',
      });
    }
    const room = Math.max(0, CASE_LIMIT - state.cases.length);
    const added = fresh.slice(0, room);
    if (added.length === 0) {
      say(`Already at ${state.cases.length} test cases or no distinct new cases were produced. Re-running the suite.`);
    } else {
      state.cases = [...state.cases, ...added];
      say(`Added ${added.length} new edge test case${added.length === 1 ? '' : 's'} (${state.cases.length} total). Running the test suite.`);
      state.casesVerified = false;
    }

    if (state.source && validSource(state.source, secret)) {
      const check = await executeCurrentCases();
      if (check.fatal) return;
      if (check.ok) {
        state.phase = 'solved';
        state.step = 'done';
        say(`All ${state.cases.length} test cases passed.`);
        return;
      }
      say(
        `${check.passedCount}/${state.cases.length} passed on the expanded test suite. Updating ${state.entry}() to handle the failing case.`,
      );
      state.hint = userHint || 'Fix the solution or input parser so all existing and newly added edge cases pass.';
      await writeAndRun('retry');
      return;
    }

    await writeAndRun('solve');
  }

  async function writeAndRun(task) {
    if (task === 'solve' && !state.source) {
      await buildHarnessIfSupported();
    }
    for (let attempt = 1; attempt <= MAX_APPROACHES; attempt += 1) {
      let fixes = 0;
      state.attempt = attempt;
      state.step = 'solve';
      say(`Writing C++17 solution inside ${state.entry}() (attempt ${attempt}/${MAX_APPROACHES})…`);
      const hint = state.pendingHint || state.hint;
      state.pendingHint = '';
      const written = await talk(task, {
        statement: state.statement,
        cases: state.cases,
        source: state.source,
        hint,
        failure: state.failure,
        entry: state.entry,
        signature: state.signature,
        format: state.format,
        stageLabel:
          attempt > 1
            ? `solving (attempt ${attempt}/${MAX_APPROACHES})`
            : THINK_LABELS[task] || 'solving',
      });
      task = 'retry';
      const formatted = cleanSource(written && written.source);
      if (!validSource(formatted, secret)) refuse(502, 'The model reply was not usable');
      state.source = formatted;
      if (!sourceHasEntry(state.source, state.entry)) {
        say(`Moving the algorithm into ${state.entry}() so main() stays only the test wrapper.`);
        const shaped = await talk('fix', {
          source: state.source,
          failure: `Put all problem-solving logic inside ${state.entry} (${state.signature || state.entry}). main() must only parse the sample input from stdin, call ${state.entry}, and print the formatted output.`,
          entry: state.entry,
          signature: state.signature,
          format: state.format,
          cases: state.cases,
        });
        const shapedClean = cleanSource(shaped && shaped.source);
        if (!validSource(shapedClean, secret) || !sourceHasEntry(shapedClean, state.entry)) {
          state.phase = 'needs_human';
          say(`I could not split this into ${state.entry}() and a main() test wrapper. Tell me how you want it structured.`);
          return;
        }
        state.source = shapedClean;
      }
      if (hasHardcodedCases(state.source, state.cases)) {
        say('Removing hardcoded sample checks so the solution uses only the general algorithm.');
        const dehardcoded = await talk('fix', {
          source: state.source,
          failure:
            'The code contains hardcoded checks for specific test case inputs or expected outputs. Remove all hardcoded test-case branches and implement the pure general algorithm that solves the problem for all valid inputs.',
          entry: state.entry,
          signature: state.signature,
          format: state.format,
          cases: state.cases,
        });
        const dehardcodedClean = cleanSource(dehardcoded && dehardcoded.source);
        if (validSource(dehardcodedClean, secret) && sourceHasEntry(dehardcodedClean, state.entry)) {
          state.source = dehardcodedClean;
        }
      }
      const nextApproach = clip(written.approach, 1_000);
      if (nextApproach && (attempt > 1 || !state.messages.some((m) => m.kind === 'plan'))) {
        state.approach = nextApproach;
        say(state.approach, 'plan');
      }
      say(`Wrote ${state.entry}() and the main() test wrapper into the editor (attempt ${attempt}/${MAX_APPROACHES}).`);

      while (fixes < MAX_COMPILE_FIXES) {
        const check = await executeCurrentCases();
        if (check.fatal) return;
        const { result, passedCount } = check;
        if (result.status === 'compile_error') {
          fixes += 1;
          say(`Compile failed. Repairing syntax (${fixes}/${MAX_COMPILE_FIXES}).`);
          const fixed = await talk('fix', {
            source: state.source,
            failure: result.compile && result.compile.stderr,
            entry: state.entry,
            signature: state.signature,
            format: state.format,
            cases: state.cases,
            stageLabel: `repairing syntax (${fixes}/${MAX_COMPILE_FIXES})`,
          });
          const fixedClean = cleanSource(fixed && fixed.source);
          if (!validSource(fixedClean, secret)) refuse(502, 'The model reply was not usable');
          state.source = fixedClean;
          continue;
        }
        if (check.ok) {
          state.phase = 'solved';
          state.step = 'done';
          say(`All ${state.cases.length} test case${state.cases.length === 1 ? '' : 's'} passed.`);
          return;
        }
        if (state.stopForCases) {
          state.phase = 'blocked';
          say('Stopping here. Tell me which expected output is wrong, or edit the case below and retry.');
          return;
        }
        const checked = state.casesVerified ? { ok: true, reason: '' } : await reviewCases();
        if (!checked.ok) {
          if (!state.casesFromProblem && checked.repairedCases && checked.repairedCases.length === state.cases.length) {
            state.cases = checked.repairedCases;
            state.casesVerified = true;
            say(
              checked.reason
                ? `Repaired generated test case expected output (${checked.reason}) and re-checking.`
                : 'Repaired generated test case expected output and re-checking.',
            );
            continue;
          }
          state.phase = 'blocked';
          say(
            checked.reason
              ? `The test cases do not match the problem. ${checked.reason}`
              : 'The test cases do not match the problem. I am not changing the program to fit them.',
          );
          return;
        }
        state.casesVerified = true;
        if (attempt === MAX_APPROACHES) {
          state.phase = 'needs_human';
          say(
            `${passedCount}/${state.cases.length} passed. The answer is still wrong after ${MAX_APPROACHES} attempts. Send an approach, edit the cases, or say the test cases are wrong.`,
          );
          return;
        }
        const failedSummary = state.cases
          .map((item, idx) =>
            item.status !== 'pass'
              ? `Case ${idx + 1} (${item.status}): input=${JSON.stringify(clip(item.input, 200))} expected=${JSON.stringify(clip(item.expected, 200))} actual=${JSON.stringify(clip(item.actual, 200))}`
              : null,
          )
          .filter(Boolean)
          .join(' | ');
        say(
          `${passedCount}/${state.cases.length} passed. The sample cases match the statement — analyzing failing case(s) for missing edge cases and trying another approach (${attempt + 1}/${MAX_APPROACHES}).`,
        );
        state.hint =
          state.pendingHint ||
          `Inspect the failing test cases (${failedSummary}) against the problem statement to see what edge case, boundary condition, or parsing detail was missed, then fix the algorithm.`;
        break;
      }
      if (fixes >= MAX_COMPILE_FIXES && state.phase !== 'solved') {
        state.phase = 'needs_human';
        say('It still does not compile after 3 repairs. Send what you want changed.');
        return;
      }
    }
  }

  function reset() {
    if (state.running && activeAbort) {
      activeAbort.abort();
      activeAbort = null;
      state.running = false;
    } else if (state.running) {
      busy();
    }
    state.phase = 'idle';
    state.step = 'idle';
    state.attempt = 0;
    state.startedAt = null;
    state.elapsedMs = 0;
    state.title = '';
    state.statement = '';
    state.entry = 'solve';
    state.signature = '';
    state.format = '';
    state.casesFromProblem = false;
    state.casesVerified = false;
    state.cases = [];
    state.images = [];
    state.source = '';
    state.approach = '';
    state.hint = '';
    state.pendingHint = '';
    state.stopForCases = false;
    state.messages = [];
    state.output = '';
    state.failure = '';
    state.activity = '';
    state.thinking = '';
    state.thinkingLabel = '';
    state.drafting = '';
    state.draftChars = 0;
    state.thoughtLog = [];
    notify(true);
    return snapshot();
  }

  async function begin(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    if (state.running) busy();
    const text = clip(input && input.text, 12_000);
    const parsedImages = normalizeImages(input);
    if (!parsedImages.ok) refuse(400, `Up to ${MAX_IMAGES} JPEG, PNG, or WebP images under 4 MB each`);
    const images = parsedImages.images;
    if (!text && images.length === 0) refuse(400, 'Send a question or an image');
    const runAbort = new AbortController();
    activeAbort = runAbort;
    state.running = true;
    state.startedAt = Date.now();
    state.elapsedMs = 0;
    state.phase = 'working';
    state.step = 'identify';
    state.attempt = 0;
    state.title = '';
    state.statement = '';
    state.entry = 'solve';
    state.signature = '';
    state.format = '';
    state.casesFromProblem = false;
    state.casesVerified = false;
    state.cases = [];
    state.images = images;
    state.source = '';
    state.approach = '';
    state.failure = '';
    state.output = '';
    state.thinking = '';
    state.thinkingLabel = '';
    state.drafting = '';
    state.draftChars = 0;
    state.thoughtLog = [];
    state.hint = clip(input.hint, 4_000);
    state.pendingHint = '';
    state.stopForCases = false;
    const attachmentLabel = images.length > 1 ? `${images.length} images attached` : 'Image attached';
    const userLabel = text && images.length > 0 ? `${text}\n(${attachmentLabel})` : text || attachmentLabel;
    state.messages = [{ role: 'user', text: redact(userLabel, secret), kind: 'user' }];
    say(
      images.length > 0
        ? `Analyzing ${images.length} attached screenshot${images.length === 1 ? '' : 's'} to extract the problem statement, signature, and sample cases…`
        : 'Analyzing problem statement, signature, and sample cases…',
    );
    try {
      const found = await talk('identify', {
        text,
        image: images[0] || null,
        images,
        source: clip(input.source, SOURCE_LIMIT),
      });
      state.title = clip(sanitizeTextField(found.title), 160);
      state.statement = clip(sanitizeTextField(found.statement), 12_000);
      state.casesFromProblem = found.casesFromProblem === true;
      if (!state.statement) refuse(502, 'The problem read reply did not include a statement.');
      say(state.statement, 'problem');
      state.entry = entryFunction(found.functionName);
      state.signature = entrySignature(state.entry, found.signature);
      state.format = clip(sanitizeTextField(found.format), 1_000);
      say(
        state.entry === 'solve'
          ? `Target: void solve() using cin/cout directly with #include <bits/stdc++.h>.`
          : `Target template: ${state.entry}() (${state.signature}). main() will parse the test input and format the output.`,
      );
      state.step = 'cases';
      if (state.casesFromProblem && validCases(found.cases)) {
        state.cases = found.cases.map((rawItem) => {
          const item = sanitizeCaseItem(rawItem);
          return {
            input: item.input,
            expected: item.expected,
            actual: '',
            stderr: '',
            reason: null,
            timeMs: 0,
            status: 'idle',
          };
        });
        say(`Loaded ${state.cases.length} sample case${state.cases.length === 1 ? '' : 's'} (bare-bones stdin format). Verifying by hand.`);
        const checked = await reviewCases();
        if (!checked.ok) {
          state.phase = 'blocked';
          say(
            checked.reason
              ? `Those sample cases do not follow from the statement. ${checked.reason}`
              : 'Those sample cases do not follow from the statement.',
          );
          return snapshot();
        }
        state.casesVerified = true;
      } else {
        say('No sample cases in the problem. Generating bare-bones test cases from the statement.');
        const made = await talk('makeCases', { statement: state.statement, format: state.format, cases: [] });
        if (!validCases(made.cases)) refuse(502, 'The model reply was not usable');
        state.cases = made.cases.slice(0, 4).map((rawItem) => {
          const item = sanitizeCaseItem(rawItem);
          return {
            input: item.input,
            expected: item.expected,
            actual: '',
            stderr: '',
            reason: null,
            timeMs: 0,
            status: 'idle',
          };
        });
        say(`Created ${state.cases.length} test case${state.cases.length === 1 ? '' : 's'}.`);
      }
      if (found.plan) {
        state.approach = clip(sanitizeTextField(found.plan), 1_000);
        say(state.approach, 'plan');
      }
      await writeAndRun('solve');
      return snapshot();
    } catch (error) {
      if (runAbort.signal.aborted || (error && error.code === 'ABORTED')) {
        return snapshot();
      }
      state.phase = state.phase === 'working' ? 'needs_human' : state.phase;
      say(error.status ? error.message : 'The agent stopped');
      if (error.status && error.status < 500) throw error;
      return snapshot();
    } finally {
      if (activeAbort === runAbort) activeAbort = null;
      if (state.startedAt) state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
      state.running = false;
      notify(true);
    }
  }

  async function guide(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    const action = input && input.action;
    if (action === 'reset') {
      return reset();
    }
    if (action === 'cancel') {
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      finishLogEntry('done');
      if (state.startedAt) state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
      state.running = false;
      if (state.phase === 'working') {
        state.phase = 'needs_human';
        say('Stopped the current run. Send guidance or retry when ready.');
      }
      notify(true);
      return snapshot();
    }
    const text = clip(input && input.text, 4_000);
    const parsedImages = normalizeImages(input);
    if (!parsedImages.ok) refuse(400, `Up to ${MAX_IMAGES} JPEG, PNG, or WebP images under 4 MB each`);
    const extraImages = parsedImages.images;
    if (state.running) {
      if (!text && extraImages.length === 0 && action !== 'retry' && action !== 'cases_wrong' && action !== 'more_cases') {
        refuse(400, 'Send an approach or some context');
      }
      if (action === 'cases_wrong') {
        state.stopForCases = true;
        say('I will pause after this run if any test case fails.');
        return snapshot();
      }
      if (extraImages.length > 0) {
        state.images = [...state.images, ...extraImages].slice(-MAX_IMAGES);
      }
      state.pendingHint =
        action === 'retry'
          ? 'Try a different approach.'
          : action === 'more_cases'
            ? 'Add more edge test cases.'
            : text || 'Use the newly attached problem screenshot(s) as well.';
      say('Queued your guidance for the next attempt.');
      return snapshot();
    }
    if (state.phase === 'idle') refuse(400, 'Start with a question or an image');
    if (action === 'cases_wrong' || /cases?.{0,40}wrong|wrong cases|samples?.{0,20}wrong/i.test(text)) {
      state.phase = 'blocked';
      say('I will not fit the program to those cases. Edit the expected output in the Test cases panel or tell me which case is wrong, then retry.');
      return snapshot();
    }
    if (input && typeof input.source === 'string' && validSource(input.source, secret)) {
      state.source = cleanSource(input.source);
    }
    if (input && Array.isArray(input.cases) && validCases(input.cases)) {
      let anyChanged = false;
      state.cases = input.cases.map((rawItem, idx) => {
        const item = sanitizeCaseItem(rawItem);
        const prev = state.cases[idx];
        const unchanged = prev && prev.input === item.input && prev.expected === item.expected;
        if (!unchanged) anyChanged = true;
        return {
          input: item.input,
          expected: item.expected,
          actual: unchanged ? prev.actual || '' : '',
          stderr: unchanged ? prev.stderr || '' : '',
          reason: unchanged ? prev.reason || null : null,
          timeMs: unchanged && typeof prev.timeMs === 'number' ? prev.timeMs : 0,
          status: unchanged ? prev.status || 'idle' : 'idle',
        };
      });
      if (anyChanged) state.casesVerified = false;
    }
    if (extraImages.length > 0) {
      state.images = [...state.images, ...extraImages].slice(-MAX_IMAGES);
      const attachmentLabel = extraImages.length > 1 ? `${extraImages.length} images attached` : 'Image attached';
      const userMsg = text ? `${text}\n(${attachmentLabel})` : attachmentLabel;
      const runAbort = new AbortController();
      activeAbort = runAbort;
      state.running = true;
      state.startedAt = Date.now();
      state.phase = 'working';
      state.step = 'identify';
      state.messages.push({ role: 'user', text: redact(userMsg, secret), kind: 'user' });
      notify(true);
      try {
        say(
          `Combining ${extraImages.length} additional screenshot${extraImages.length === 1 ? '' : 's'} with the current problem (${state.images.length} total).`,
        );
        const merged = await talk('identify', {
          text,
          statement: state.statement,
          cases: state.cases,
          image: state.images[0] || null,
          images: state.images,
          source: state.source,
        });
        if (merged && merged.title) state.title = clip(sanitizeTextField(merged.title), 160);
        if (merged && merged.statement) {
          state.statement = clip(sanitizeTextField(merged.statement), 12_000);
          say(state.statement, 'problem');
        }
        if (merged && merged.functionName) {
          const nextEntry = entryFunction(merged.functionName);
          if (nextEntry !== state.entry) {
            state.entry = nextEntry;
            state.source = '';
          }
        }
        if (merged && merged.signature) state.signature = entrySignature(state.entry, merged.signature);
        if (merged && merged.format) state.format = clip(sanitizeTextField(merged.format), 1_000);
        if (merged && merged.casesFromProblem && validCases(merged.cases)) {
          const seen = new Set(state.cases.map((item) => item.input.trim()));
          for (const rawItem of merged.cases) {
            const item = sanitizeCaseItem(rawItem);
            const key = item.input.trim();
            if (!key || seen.has(key) || state.cases.length >= CASE_LIMIT) continue;
            seen.add(key);
            state.cases.push({
              input: item.input,
              expected: item.expected,
              actual: '',
              stderr: '',
              reason: null,
              timeMs: 0,
              status: 'idle',
            });
            state.casesVerified = false;
          }
        }
        if (merged && merged.plan) {
          state.approach = clip(sanitizeTextField(merged.plan), 1_000);
        }
        state.hint = text || 'Use all combined problem parts, constraints, and sample cases.';
        await writeAndRun(state.source ? 'retry' : 'solve');
        if (state.phase === 'working') state.phase = 'needs_human';
        return snapshot();
      } catch (error) {
        if (runAbort.signal.aborted || (error && error.code === 'ABORTED')) {
          return snapshot();
        }
        state.phase = 'needs_human';
        say(error.status ? error.message : 'The agent stopped');
        if (error.status && error.status < 500) throw error;
        return snapshot();
      } finally {
        if (activeAbort === runAbort) activeAbort = null;
        if (state.startedAt) state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
        state.running = false;
        notify(true);
      }
    }
    if (wantsMoreCases(text, action)) {
      const userMsg = text || 'Add more edge test cases for thorough testing.';
      const runAbort = new AbortController();
      activeAbort = runAbort;
      state.running = true;
      state.startedAt = Date.now();
      state.elapsedMs = 0;
      state.phase = 'working';
      state.messages.push({ role: 'user', text: redact(userMsg, secret), kind: 'user' });
      notify(true);
      try {
        await addCasesAndTest(userMsg);
        if (state.phase === 'working') state.phase = 'needs_human';
        return snapshot();
      } catch (error) {
        if (runAbort.signal.aborted || (error && error.code === 'ABORTED')) {
          return snapshot();
        }
        state.phase = 'needs_human';
        say(error.status ? error.message : 'The agent stopped');
        if (error.status && error.status < 500) throw error;
        return snapshot();
      } finally {
        if (activeAbort === runAbort) activeAbort = null;
        if (state.startedAt) state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
        state.running = false;
        notify(true);
      }
    }
    const hint = action === 'retry' ? 'Try a different approach than the one already written.' : text;
    if (!hint) refuse(400, 'Send an approach or some context');
    const runAbort = new AbortController();
    activeAbort = runAbort;
    state.running = true;
    state.startedAt = Date.now();
    state.elapsedMs = 0;
    state.phase = 'working';
    state.hint = hint;
    state.messages.push({ role: 'user', text: redact(state.hint, secret), kind: 'user' });
    notify(true);
    try {
      await writeAndRun('retry');
      if (state.phase === 'working') state.phase = 'needs_human';
      return snapshot();
    } catch (error) {
      if (runAbort.signal.aborted || (error && error.code === 'ABORTED')) {
        return snapshot();
      }
      state.phase = 'needs_human';
      say(error.status ? error.message : 'The agent stopped');
      if (error.status && error.status < 500) throw error;
      return snapshot();
    } finally {
      if (activeAbort === runAbort) activeAbort = null;
      if (state.startedAt) state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
      state.running = false;
      notify(true);
    }
  }

  async function ask(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    const text = clip(input && input.text, 4_000);
    if (!text) refuse(400, 'Ask a question');
    const answer = await talk('ask', { text, source: clip(input.source, SOURCE_LIMIT) });
    const reply = redact(clip(answer.text, 4_000), secret);
    return { configured: true, text: reply || 'No answer.' };
  }

  return { begin, guide, ask, reset, snapshot, subscribe };
}

module.exports = {
  createAgentControl,
  createGemini,
  parseModelJson,
  extractDraftPreview,
  imageOk,
  normalizeImages,
  redact,
  entryFunction,
  entrySignature,
  sanitizeTextField,
  sanitizeCaseItem,
  sourceHasEntry,
  cleanSource,
  wantsMoreCases,
  MODEL,
};
