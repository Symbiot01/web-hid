'use strict';

const { spawn } = require('node:child_process');
const fsSync = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');

const SOURCE_MAX = 64 * 1024;
const CHECK_MS = 3_000;
const CHECK_AS = 256 * 1024 * 1024;
const CHECK_FSIZE = 1024 * 1024;
const OUTPUT_MAX = 8 * 1024;
const HAS_LIB64 = fsSync.existsSync('/lib64');

const VALID_TYPES = new Set(['cpp', 'python', 'sql', 'bash', 'dockerfile', 'yaml', 'javascript']);

const DEFAULT_FILES = {
  cpp: 'main.cpp',
  python: 'solution.py',
  sql: 'query.sql',
  bash: 'script.sh',
  dockerfile: 'Dockerfile',
  yaml: 'config.yaml',
  javascript: 'solution.js',
};

function normalizeProblemType(rawType, rawFileName) {
  const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
  if (VALID_TYPES.has(type)) return type;
  if (type === 'c++' || type === 'cxx' || type === 'cc') return 'cpp';
  if (type === 'py' || type === 'python3') return 'python';
  if (type === 'postgres' || type === 'postgresql' || type === 'mysql' || type === 'sqlite') return 'sql';
  if (type === 'sh' || type === 'shell' || type === 'zsh') return 'bash';
  if (type === 'docker' || type === 'container') return 'dockerfile';
  if (type === 'yml') return 'yaml';
  if (type === 'js' || type === 'node' || type === 'typescript' || type === 'ts') return 'javascript';

  const file = typeof rawFileName === 'string' ? rawFileName.trim().toLowerCase() : '';
  if (file.endsWith('.py')) return 'python';
  if (file.endsWith('.sql')) return 'sql';
  if (file.endsWith('.sh') || file.endsWith('.bash')) return 'bash';
  if (file === 'dockerfile' || file.startsWith('dockerfile.')) return 'dockerfile';
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'yaml';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'javascript';
  return 'cpp';
}

function canonicalFileName(problemType, rawFileName) {
  const type = normalizeProblemType(problemType, rawFileName);
  return DEFAULT_FILES[type] || 'main.cpp';
}

function sandboxArgs(command) {
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--uid',
    '0',
    '--gid',
    '0',
    '--hostname',
    'sandbox',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    ...(HAS_LIB64 ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'PYTHONDONTWRITEBYTECODE',
    '1',
    ...command,
  ];
}

function limited(command) {
  const seconds = Math.max(1, Math.ceil(CHECK_MS / 1000));
  return [
    'prlimit',
    `--as=${CHECK_AS}`,
    `--data=${CHECK_AS}`,
    `--fsize=${CHECK_FSIZE}`,
    '--nofile=32',
    `--cpu=${seconds + 1}`,
    '--',
    'timeout',
    '-k',
    '1s',
    `${seconds}s`,
    ...command,
  ];
}

function spawnCheck(bin, args, { stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHECK_MS + 1000);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_MAX) stdout += chunk.toString('utf8').slice(0, OUTPUT_MAX - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_MAX) stderr += chunk.toString('utf8').slice(0, OUTPUT_MAX - stderr.length);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function runSandboxCommand(command, stdin) {
  const cmd = limited(command);
  try {
    const res = await spawnCheck('bwrap', sandboxArgs(cmd), { stdin });
    if (res.code !== 1 || !/^bwrap:/m.test(res.stderr)) {
      return res;
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return spawnCheck(cmd[0], cmd.slice(1), { stdin });
}

function checkSqlSyntax(source) {
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, stderr: 'SQL query is empty.' };
  }

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;
  let lineNum = 1;
  let parenOpenLine = 1;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '\n') {
      lineNum += 1;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'" && next === "'") {
        i += 1;
      } else if (ch === '\\' && i + 1 < source.length) {
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"' && next === '"') {
        i += 1;
      } else if (ch === '\\' && i + 1 < source.length) {
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') {
      if (parenDepth === 0) parenOpenLine = lineNum;
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) {
        return { ok: false, stderr: `Line ${lineNum}: unexpected closing parenthesis ')' in SQL.` };
      }
    }
  }

  if (inBlockComment) return { ok: false, stderr: 'Unclosed block comment /* ... */ in SQL.' };
  if (inSingle) return { ok: false, stderr: "Unclosed single-quoted string literal (') in SQL." };
  if (inDouble) return { ok: false, stderr: 'Unclosed double-quoted identifier (") in SQL.' };
  if (inBacktick) return { ok: false, stderr: 'Unclosed backtick identifier (`) in SQL.' };
  if (parenDepth !== 0) {
    return {
      ok: false,
      stderr: `Line ${parenOpenLine}: unclosed parenthesis '(' in SQL (${parenDepth} unclosed).`,
    };
  }

  const withoutComments = source
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!withoutComments) {
    return { ok: false, stderr: 'SQL contains only comments and no executable statement.' };
  }
  const startsWithValidKeyword =
    /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|MERGE|EXPLAIN|SHOW|DESCRIBE|PRAGMA|BEGIN|DECLARE|SET|VALUES)\b/i.test(
      withoutComments,
    );
  if (!startsWithValidKeyword) {
    const firstToken = withoutComments.split(/\s+/)[0] || '';
    return {
      ok: false,
      stderr: `SQL statement begins with unexpected token '${firstToken.slice(0, 32)}'. Expected SELECT, WITH, INSERT, UPDATE, CREATE, etc.`,
    };
  }
  if (/^WITH\b/i.test(withoutComments) && !/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(withoutComments)) {
    return {
      ok: false,
      stderr: 'SQL WITH (CTE) clause is missing a main SELECT/INSERT/UPDATE/DELETE query.',
    };
  }
  if (/\bSELECT\s+FROM\b/i.test(withoutComments)) {
    return {
      ok: false,
      stderr: 'SQL syntax error: empty projection in "SELECT FROM" (missing column list).',
    };
  }
  return { ok: true, stderr: '' };
}

const DOCKERFILE_DIRECTIVES = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'MAINTAINER',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
]);

function checkDockerfileSyntax(source) {
  const rawLines = source.replace(/\r\n/g, '\n').split('\n');
  let sawFrom = false;
  let instructionCount = 0;
  const stages = new Set();

  let logicalLine = '';
  let logicalStartLine = 1;
  let inContinuation = false;

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    if (!inContinuation) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      logicalStartLine = i + 1;
      logicalLine = '';
    } else if (trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.endsWith('\\')) {
      logicalLine += `${trimmed.slice(0, -1)} `;
      inContinuation = true;
      continue;
    }

    logicalLine += trimmed;
    inContinuation = false;

    const match = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(logicalLine.trim());
    if (!match) {
      return { ok: false, stderr: `Line ${logicalStartLine}: invalid Dockerfile instruction syntax.` };
    }
    const directive = match[1].toUpperCase();
    const rest = (match[2] || '').trim();
    if (!DOCKERFILE_DIRECTIVES.has(directive)) {
      return {
        ok: false,
        stderr: `Line ${logicalStartLine}: unknown Dockerfile instruction '${match[1]}'.`,
      };
    }
    if (!rest) {
      return {
        ok: false,
        stderr: `Line ${logicalStartLine}: Dockerfile instruction '${directive}' is missing arguments.`,
      };
    }
    if (!sawFrom && directive !== 'ARG' && directive !== 'FROM') {
      return {
        ok: false,
        stderr: `Line ${logicalStartLine}: Dockerfile must start with 'FROM' (or 'ARG' before 'FROM'), found '${directive}'.`,
      };
    }
    if (directive === 'FROM') {
      sawFrom = true;
      const stageMatch = /\bAS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(rest);
      if (stageMatch && stageMatch[1]) {
        stages.add(stageMatch[1].toLowerCase());
      }
    }
    if (directive === 'COPY' || directive === 'ADD') {
      const tokens = rest.replace(/^--[A-Za-z0-9_-]+=[^\s]+\s+/g, '').trim().split(/\s+/);
      if (tokens.length < 2 && !rest.startsWith('[')) {
        return {
          ok: false,
          stderr: `Line ${logicalStartLine}: '${directive}' requires at least a source and a destination.`,
        };
      }
    }
    instructionCount += 1;
  }

  if (inContinuation) {
    return {
      ok: false,
      stderr: `Line ${logicalStartLine}: trailing line continuation '\\' at end of Dockerfile.`,
    };
  }
  if (!sawFrom || instructionCount === 0) {
    return { ok: false, stderr: 'Dockerfile must contain at least one valid FROM instruction.' };
  }
  return { ok: true, stderr: '' };
}

function checkYamlSyntax(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let nonEmpty = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    nonEmpty += 1;
    if (/^\t+/.test(line)) {
      return {
        ok: false,
        stderr: `Line ${i + 1}: YAML does not allow tab characters for indentation.`,
      };
    }
  }
  if (nonEmpty === 0) {
    return { ok: false, stderr: 'YAML file is empty.' };
  }
  return { ok: true, stderr: '' };
}

function checkJavaScriptSyntax(source) {
  if (!source.trim()) {
    return { ok: false, stderr: 'JavaScript file is empty.' };
  }
  try {
    // Compile only (does not execute the script)
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: 'solution.js' });
    return { ok: true, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stderr: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : 'JavaScript syntax error',
    };
  }
}

async function checkSyntax(problemType, source) {
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, stderr: 'Source is empty.' };
  }
  if (source.length > SOURCE_MAX) {
    return { ok: false, stderr: 'Source exceeds 64 KB limit.' };
  }
  const type = normalizeProblemType(problemType);
  if (type === 'python') {
    const res = await runSandboxCommand(
      [
        'python3',
        '-I',
        '-c',
        "import ast, sys; ast.parse(sys.stdin.read(), filename='solution.py')",
      ],
      source,
    );
    if (res.code !== 0) {
      return {
        ok: false,
        stderr: (res.stderr || res.stdout || 'Python syntax error').trim(),
      };
    }
    return { ok: true, stderr: '' };
  }

  if (type === 'bash') {
    const res = await runSandboxCommand(['bash', '-n'], source);
    if (res.code !== 0) {
      return {
        ok: false,
        stderr: (res.stderr || res.stdout || 'Bash syntax error').trim(),
      };
    }
    return { ok: true, stderr: '' };
  }

  if (type === 'sql') {
    return checkSqlSyntax(source);
  }

  if (type === 'dockerfile') {
    return checkDockerfileSyntax(source);
  }

  if (type === 'yaml') {
    return checkYamlSyntax(source);
  }

  if (type === 'javascript') {
    return checkJavaScriptSyntax(source);
  }

  return { ok: true, stderr: '' };
}

module.exports = {
  VALID_TYPES,
  DEFAULT_FILES,
  normalizeProblemType,
  canonicalFileName,
  checkSyntax,
  checkSqlSyntax,
  checkDockerfileSyntax,
  checkYamlSyntax,
  checkJavaScriptSyntax,
};
