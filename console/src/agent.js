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

function entrySignature(entry, rawSignature) {
  const name = entryFunction(entry);
  if (name === 'solve') return 'void solve()';
  const sig = clip(rawSignature, 300).trim();
  return sig || `${name}(...)`;
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
  const lines = normalized.split('\n');
  const suspicious = lines.some(
    (line) =>
      (line.match(/\{/g) || []).length >= 2 ||
      (line.length > 100 && line.includes(';') && line.includes('{')),
  );
  if (!suspicious) return `${normalized}\n`;

  let out = '';
  let indent = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];
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
      if (ch === '\\' && i + 1 < normalized.length) {
        out += normalized[i + 1];
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
      while (normalized[i + 1] === ' ' || normalized[i + 1] === '\t') i += 1;
      if (normalized[i + 1] === '\n') i += 1;
      out += '  '.repeat(Math.max(0, indent));
      continue;
    }
    if (ch === '}' && parenDepth === 0) {
      indent = Math.max(0, indent - 1);
      out = out.replace(/[ \t]+$/, '');
      if (!out.endsWith('\n')) out += '\n';
      out += `${'  '.repeat(indent)}}`;
      if (normalized[i + 1] === ';') {
        out += ';';
        i += 1;
      }
      out += '\n';
      while (normalized[i + 1] === ' ' || normalized[i + 1] === '\t') i += 1;
      if (normalized[i + 1] === '\n') i += 1;
      out += '  '.repeat(Math.max(0, indent));
      continue;
    }
    if (ch === ';' && parenDepth === 0) {
      out += ';';
      let look = i + 1;
      while (normalized[look] === ' ' || normalized[look] === '\t') look += 1;
      if (normalized[look] && normalized[look] !== '\n' && normalized[look] !== '}' && normalized[look] !== '/') {
        out += `\n${'  '.repeat(Math.max(0, indent))}`;
        i = look - 1;
      }
      continue;
    }
    if (ch === '\n') {
      out = out.replace(/[ \t]+$/, '');
      out += '\n';
      while (normalized[i + 1] === ' ' || normalized[i + 1] === '\t') i += 1;
      const upcomingClose = normalized[i + 1] === '}';
      out += '  '.repeat(Math.max(0, upcomingClose ? indent - 1 : indent));
      continue;
    }
    out += ch;
  }
  return `${out.replace(/\n{3,}/g, '\n\n').trim()}\n`;
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
        'You extract programming problems from text or screenshots across any platform (Codeforces, LeetCode, AtCoder, CSES, ICPC, HackerRank, or custom specifications).',
        'If multiple images/screenshots are provided, they show different parts of the SAME problem (description, examples, constraints, starter code template). Combine all images and any existing context into one complete specification.',
        'Reply with JSON only: {"title":"","statement":"","casesFromProblem":false,"cases":[{"input":"","expected":""}],"plan":"","functionName":"","signature":"","format":""}.',
        '- title: short problem title (e.g. "Median of Two Sorted Arrays", "Shortest Routes I").',
        '- statement: complete, clean problem statement combining all parts, including input/output rules, constraints, and edge conditions. If a starter code template or class/function stub is shown in the prompt, screenshot, or editor, include that template signature in statement.',
        '- casesFromProblem / cases: extract all sample inputs and outputs across all provided screenshots/context ONLY when shown in the problem. If none are shown, set casesFromProblem to false and cases to []. Never guess or invent sample outputs here.',
        '- Agentic Bare-Bones Competitive Programming Format (MANDATORY):',
        '  * Convert every sample `input` and `expected` output into clean, bare-bones competitive programming stdin/stdout so `cin >>` can read it directly without string/bracket parsing:',
        '  * 1D Arrays & Scalars: Strip variable labels (`arr[] =`, `nums1 =`, `target =`, `s =`), brackets `[...]`, `{...}`, quotes `"..."`, and commas. Prefix every 1D array with its length `n` on a line followed by `n` space-separated elements on the next line (unless `n` is already given immediately before it). Example: `arr[] = [1, 2, 3, 4, 5]` -> `"5\\n1 2 3 4 5\\n"`; `nums = [2,7,11,15], target = 9` -> `"4\\n2 7 11 15\\n9\\n"`.',
        '  * 2D Arrays / Grids: Convert `[[1,2,3],[4,5,6]]` into `"2 3\\n1 2 3\\n4 5 6\\n"` (`rows cols` followed by each row).',
        '  * Query / Class-Design Problems (e.g. `["RandomizedCollection", "insert", "remove", "getRandom"]` with `[[], [1], [1], []]`, or `LRUCache`, `Trie`, `MinStack`): Convert the parallel command/argument arrays into bare-bones query lines: first line is the operation count `q` (plus any constructor args if needed), followed by `q` lines of `op arg1 arg2...` (e.g. `"6\\ninsert 1\\ninsert 1\\ninsert 2\\ngetRandom\\nremove 1\\ngetRandom\\n"`), and bare expected outputs (e.g. `"true false true 2 true 1\\n"` or one result per query).',
        '  * Expected Outputs: Strip outer `[` `]`, quotes, and commas into bare space- or newline-separated tokens (e.g. `[0, 1]` -> `"0 1\\n"`).',
        '- Template vs. Standard Competitive Programming rule:',
        '  1. IF a starter template / function or class signature is given in the problem or screenshot (e.g. LeetCode/HackerRank `class Solution` with `findMedianSortedArrays`, or an OOP design class like `class RandomizedCollection` / `class LRUCache`): conform strictly to that template — set `functionName` to that exact method or class name and `signature` to its exact C++17 signature.',
        '  2. OTHERWISE (standard stdin/stdout competitive programming like Codeforces, AtCoder, CSES, ICPC, or no template given): ALWAYS set `functionName` to `"solve"` and `signature` to `"void solve()"` (never `void solve(istream&, ostream&)`). In Codeforces style, `void solve()` reads directly from `cin` and writes directly to `cout`.',
        '- format: precise description of the bare-bones stdin token order (e.g. "Line 1: n. Line 2: n space-separated integers." or "Line 1: q. Next q lines: operation name followed by its arguments.") and bare-bones stdout format.',
        '- plan: 1-2 sentences stating the optimal algorithm and its time and space complexity.',
      ].join('\n'),
      user: `Problem text:\n${clip(context.text, 12_000)}${prior}\n\nCurrent editor file:\n${source}`,
    };
  }
  if (task === 'review') {
    return {
      system: [
        'You verify sample test cases by hand against the problem statement. Do not write a program. Reply with JSON only: {"ok":true,"reason":""}.',
        '- Note that Cases may be formatted in bare-bones competitive programming stdin/stdout (e.g. array size `n` followed by elements, or `q` lines of `op arg` queries without `null` for constructor).',
        '- If an operation is randomized (e.g. `getRandom()`) or the problem allows multiple valid answers ("return any valid..."), set `ok` to `true` as long as the expected output is a valid possible outcome.',
        '- Set `ok` to `false` ONLY when a sample expected output is mathematically impossible under the problem statement.',
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
        'Write a clean, minimal C++17 test harness (`int main()`) and a compilable stub for the target function or class.',
        'Reply with JSON only: {"source":""}.',
        'Header & style rules (mandatory):',
        '- ALWAYS start with `#include <bits/stdc++.h>` and `using namespace std;` instead of listing multiple individual standard library headers.',
        '- Write the simplest, cleanest C++17 code possible with 2-space indentation.',
        'Structure rules:',
        `- Mode A — Standard Competitive Programming (\`${entry}\` is \`solve\` and signature is \`void solve()\`):`,
        '  * Write `void solve() {}` above `main()` (it takes NO parameters — never `istream&` or `ostream&` — and will use `cin` and `cout` directly).',
        '  * Keep `main()` minimal in classic Codeforces style (`ios_base::sync_with_stdio(false); cin.tie(nullptr);`, and either call `solve();` directly or `int t; if (cin >> t) while (t--) solve();` depending on whether the problem has multiple test cases per input).',
        `- Mode B — Template Function or Class Given (\`${signature}\` has parameters/return value or is a class like \`${entry}\`):`,
        `  * Include any required structs (\`ListNode\`, \`TreeNode\` if used in \`${signature}\`) and the function/class \`${signature}\` with minimal placeholder returns so it compiles.`,
        `  * Test cases are in bare-bones competitive programming stdin format (e.g. \`5\\n1 2 3 4 5\\n\` for arrays, or \`q\` lines of \`op args...\` for query/class problems). In \`main()\`, read inputs directly using clean \`cin >>\` loops, call \`${entry}\` (or instantiate \`${entry}\` and dispatch queries), and print the bare result to \`cout\` matching Cases.`,
      ].join('\n'),
      user: `Statement:\n${statement}\n\nTarget function:\n${entry}\n\nSignature:\n${signature}\n\nSample format:\n${format}\n\nCases:\n${cases}`,
    };
  }
  if (task === 'solve' || task === 'retry') {
    return {
      system: [
        'Write the simplest, cleanest, optimal C++17 solution program.',
        'Reply with JSON only: {"source":"","approach":""}.',
        'Code style & structure rules (mandatory):',
        '1. Header: ALWAYS use `#include <bits/stdc++.h>` and `using namespace std;` at the top instead of listing individual standard headers (`<iostream>`, `<vector>`, `<algorithm>`, etc.).',
        '2. Template conformance vs. `void solve()`:',
        `   - If a specific function or class template was given (\`${signature}\`): conform to that signature, put the algorithm inside \`${entry}\`, and keep \`main()\` at the bottom strictly as the test wrapper that parses bare-bones \`cin\`, calls/dispatches \`${entry}\`, and prints to \`cout\`.`,
        '   - Otherwise (standard competitive programming / Codeforces style): use `void solve()` with NO parameters (never `istream& in, ostream& out`). Read input directly from `cin` and print output directly to `cout` inside `solve()` (or per-testcase inside `solve()` with `int t; cin >> t; while (t--) solve();` in `main()`).',
        '3. Keep the code as simple, direct, and readable as possible — avoid over-engineering, unnecessary boilerplate, or stream-passing abstractions.',
        '4. Cases use bare-bones whitespace-separated stdin (e.g. array size `n` followed by `n` space-separated elements `5\\n1 2 3 4 5\\n`, or `q` lines of `op arg...` for query/class problems). Read inputs with simple `cin >>` in `main()` (for template functions/classes) or `solve()`, and print bare space/newline-separated output matching Cases.',
        '5. Handle algorithmic edge cases: `long long` for 64-bit sums/products/distances, 1-based vs 0-based indexing, empty/single-element inputs, duplicates, and boundary constraints.',
        '6. Match the exact expected output format (`fixed << setprecision(...)`, `true`/`false`, `YES`/`NO`, or space/newline-separated answers).',
        '7. Format across multiple lines with 2-space indentation. Do not open files, spawn processes, or use the network. `approach` is 1-2 concise sentences stating the algorithm and time/space complexity.',
      ].join('\n'),
      user: `Statement:\n${statement}\n\nFunction:\n${entry}\n\nSignature:\n${signature}\n\nSample format:\n${format}\n\nCases:\n${cases}\n\nApproach:\n${hint || 'Use the simplest optimal algorithm that handles all constraints and edge cases.'}\n\nPrevious source:\n${source}\n\nPrevious result:\n${failure}`,
    };
  }
  if (task === 'fix') {
    return {
      system: [
        'Repair the C++17 program so it compiles cleanly and remains simple and readable.',
        'Reply with JSON only: {"source":""}.',
        '- Prefer `#include <bits/stdc++.h>` and `using namespace std;` at the top.',
        `- Keep all algorithm logic inside \`${entry}\` above \`main()\`. If \`${entry}\` is \`solve\`, use \`void solve()\` reading from \`cin\` and writing to \`cout\` directly.`,
        `- Keep \`main()\` minimal at the bottom calling \`${entry}\`.`,
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

function createGemini({ apiKey, model, fetchImpl }) {
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
        thinkingLevel: task === 'solve' || task === 'retry' ? 'MEDIUM' : 'LOW',
      };
    }
    let lastError = null;
    for (let tryNum = 0; tryNum < 2; tryNum += 1) {
      let response;
      try {
        response = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: built.system }] },
              contents: [{ role: 'user', parts }],
              generationConfig,
            }),
            signal: AbortSignal.timeout(120_000),
          },
        );
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!response.ok) {
        lastError = new Error('The model request failed');
        lastError.status = 502;
        if (response.status >= 500 || response.status === 429) continue;
        throw lastError;
      }
      try {
        const payload = await response.json();
        const chunks =
          payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content
            ? payload.candidates[0].content.parts || []
            : [];
        const text = chunks
          .filter((part) => part && !part.thought && typeof part.text === 'string')
          .map((part) => part.text)
          .join('');
        return parseModelJson(redact(text, apiKey));
      } catch (err) {
        lastError = err;
      }
    }
    const error = new Error(lastError && lastError.status ? lastError.message : 'The model request failed');
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
  const talk =
    generate ||
    createGemini({
      apiKey: secret,
      model: model || MODEL,
    });
  const state = {
    phase: 'idle',
    step: 'idle',
    attempt: 0,
    running: false,
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
  };

  function say(text, kind) {
    const clean = redact(clip(text, 4_000), secret);
    if (!clean) return;
    state.messages.push({ role: 'assistant', text: clean, kind: kind || 'step' });
    if (state.messages.length > 40) state.messages.splice(0, state.messages.length - 40);
  }

  function noteOutput(text) {
    state.output = clip(`${state.output}${text}\n`, OUTPUT_LIMIT);
  }

  function snapshot() {
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
    return { ok, reason };
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
      }
    } catch {
      // If the optional harness pre-step fails, solve will generate both the wrapper and entry function.
    }
  }

  async function executeCurrentCases() {
    state.step = 'test';
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
    for (const item of made.cases) {
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
        const checked = await reviewCases();
        if (!checked.ok) {
          state.phase = 'blocked';
          say(
            checked.reason
              ? `The test cases do not match the problem. ${checked.reason}`
              : 'The test cases do not match the problem. I am not changing the program to fit them.',
          );
          return;
        }
        if (attempt === MAX_APPROACHES) {
          state.phase = 'needs_human';
          say(
            `${passedCount}/${state.cases.length} passed. The answer is still wrong after ${MAX_APPROACHES} attempts. Send an approach, edit the cases, or say the test cases are wrong.`,
          );
          return;
        }
        say(
          `${passedCount}/${state.cases.length} passed. The sample cases match the statement — checking input parsing and trying another approach (${attempt + 1}/${MAX_APPROACHES}).`,
        );
        state.hint =
          state.pendingHint ||
          'Check whether main() misparsed the case input or output format; if parsing is right, use a different algorithm inside the solution function.';
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
    if (state.running) refuse(409, 'Agent is already working');
    state.phase = 'idle';
    state.step = 'idle';
    state.attempt = 0;
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
    return snapshot();
  }

  async function begin(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    if (state.running) refuse(409, 'Agent is already working');
    const text = clip(input && input.text, 12_000);
    const parsedImages = normalizeImages(input);
    if (!parsedImages.ok) refuse(400, `Up to ${MAX_IMAGES} JPEG, PNG, or WebP images under 4 MB each`);
    const images = parsedImages.images;
    if (!text && images.length === 0) refuse(400, 'Send a question or an image');
    state.running = true;
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
      state.title = clip(found.title, 160);
      state.statement = clip(found.statement, 12_000);
      state.casesFromProblem = found.casesFromProblem === true;
      if (!state.statement) refuse(502, 'The model reply was not usable');
      say(state.statement, 'problem');
      state.entry = entryFunction(found.functionName);
      state.signature = entrySignature(state.entry, found.signature);
      state.format = clip(found.format, 1_000);
      say(
        state.entry === 'solve'
          ? `Target: void solve() using cin/cout directly with #include <bits/stdc++.h>.`
          : `Target template: ${state.entry}() (${state.signature}). main() will parse the test input and format the output.`,
      );
      state.step = 'cases';
      if (state.casesFromProblem && validCases(found.cases)) {
        state.cases = found.cases.map((item) => ({
          input: item.input,
          expected: item.expected,
          actual: '',
          stderr: '',
          reason: null,
          timeMs: 0,
          status: 'idle',
        }));
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
        state.cases = made.cases.slice(0, 4).map((item) => ({
          input: item.input,
          expected: item.expected,
          actual: '',
          stderr: '',
          reason: null,
          timeMs: 0,
          status: 'idle',
        }));
        say(`Created ${state.cases.length} test case${state.cases.length === 1 ? '' : 's'}.`);
      }
      if (found.plan) {
        state.approach = clip(found.plan, 1_000);
        say(state.approach, 'plan');
      }
      await writeAndRun('solve');
      return snapshot();
    } catch (error) {
      state.phase = state.phase === 'working' ? 'needs_human' : state.phase;
      say(error.status ? error.message : 'The agent stopped');
      if (error.status && error.status < 500) throw error;
      return snapshot();
    } finally {
      state.running = false;
    }
  }

  async function guide(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    const action = input && input.action;
    if (action === 'reset') {
      return reset();
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
      state.cases = input.cases.map((item, idx) => {
        const prev = state.cases[idx];
        const unchanged = prev && prev.input === item.input && prev.expected === item.expected;
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
    }
    if (extraImages.length > 0) {
      state.images = [...state.images, ...extraImages].slice(-MAX_IMAGES);
      const attachmentLabel = extraImages.length > 1 ? `${extraImages.length} images attached` : 'Image attached';
      const userMsg = text ? `${text}\n(${attachmentLabel})` : attachmentLabel;
      state.running = true;
      state.phase = 'working';
      state.step = 'identify';
      state.messages.push({ role: 'user', text: redact(userMsg, secret), kind: 'user' });
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
        if (merged && merged.title) state.title = clip(merged.title, 160);
        if (merged && merged.statement) {
          state.statement = clip(merged.statement, 12_000);
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
        if (merged && merged.format) state.format = clip(merged.format, 1_000);
        if (merged && merged.casesFromProblem && validCases(merged.cases)) {
          const seen = new Set(state.cases.map((item) => item.input.trim()));
          for (const item of merged.cases) {
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
          }
        }
        if (merged && merged.plan) {
          state.approach = clip(merged.plan, 1_000);
        }
        state.hint = text || 'Use all combined problem parts, constraints, and sample cases.';
        await writeAndRun(state.source ? 'retry' : 'solve');
        if (state.phase === 'working') state.phase = 'needs_human';
        return snapshot();
      } catch (error) {
        state.phase = 'needs_human';
        say(error.status ? error.message : 'The agent stopped');
        if (error.status && error.status < 500) throw error;
        return snapshot();
      } finally {
        state.running = false;
      }
    }
    if (wantsMoreCases(text, action)) {
      const userMsg = text || 'Add more edge test cases for thorough testing.';
      state.running = true;
      state.phase = 'working';
      state.messages.push({ role: 'user', text: redact(userMsg, secret), kind: 'user' });
      try {
        await addCasesAndTest(userMsg);
        if (state.phase === 'working') state.phase = 'needs_human';
        return snapshot();
      } catch (error) {
        state.phase = 'needs_human';
        say(error.status ? error.message : 'The agent stopped');
        if (error.status && error.status < 500) throw error;
        return snapshot();
      } finally {
        state.running = false;
      }
    }
    const hint = action === 'retry' ? 'Try a different approach than the one already written.' : text;
    if (!hint) refuse(400, 'Send an approach or some context');
    state.running = true;
    state.phase = 'working';
    state.hint = hint;
    state.messages.push({ role: 'user', text: redact(state.hint, secret), kind: 'user' });
    try {
      await writeAndRun('retry');
      if (state.phase === 'working') state.phase = 'needs_human';
      return snapshot();
    } catch (error) {
      state.phase = 'needs_human';
      say(error.status ? error.message : 'The agent stopped');
      if (error.status && error.status < 500) throw error;
      return snapshot();
    } finally {
      state.running = false;
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

  return { begin, guide, ask, reset, snapshot };
}

module.exports = {
  createAgentControl,
  createGemini,
  parseModelJson,
  imageOk,
  normalizeImages,
  redact,
  entryFunction,
  entrySignature,
  sourceHasEntry,
  cleanSource,
  wantsMoreCases,
  MODEL,
};
