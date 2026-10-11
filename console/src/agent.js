'use strict';

const MODEL = 'gemini-3.1-pro-preview';
const MAX_APPROACHES = 3;
const MAX_COMPILE_FIXES = 3;
const CASE_LIMIT = 8;
const TEXT_LIMIT = 8_000;
const SOURCE_LIMIT = 64 * 1024;
const IMAGE_MAX = 4 * 1024 * 1024;
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

function parseModelJson(text) {
  const trimmed = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const error = new Error('The model reply was not usable');
    error.status = 502;
    throw error;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('The model reply was not usable');
      error.status = 502;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error('The model reply was not usable');
    wrapped.status = 502;
    throw wrapped;
  }
}

function promptFor(task, context) {
  const statement = clip(context.statement, 12_000);
  const cases = JSON.stringify(context.cases || []).slice(0, 20_000);
  const hint = clip(context.hint, 4_000);
  const source = clip(context.source, 20_000);
  const failure = clip(context.failure, 6_000);
  if (task === 'identify') {
    return {
      system:
        'You extract programming problems. Reply with JSON only: {"statement":"","casesFromProblem":false,"cases":[{"input":"","expected":""}],"plan":""}. Copy sample inputs and outputs only when they are visible. If none are visible, casesFromProblem is false and cases is empty. Do not invent expected output.',
      user: `Problem text:\n${clip(context.text, 12_000)}\n\nCurrent editor file:\n${source}`,
    };
  }
  if (task === 'review') {
    return {
      system:
        'You check sample cases by hand against the problem statement. Do not write a program. Reply with JSON only: {"ok":true,"reason":""}. ok is false when an expected output does not follow from the statement.',
      user: `Statement:\n${statement}\n\nCases:\n${cases}`,
    };
  }
  if (task === 'makeCases') {
    return {
      system:
        'Write 2 to 4 stdin/stdout samples for this problem, including an edge case. Reply with JSON only: {"cases":[{"input":"","expected":""}]}. Expected output must follow from the statement.',
      user: `Statement:\n${statement}`,
    };
  }
  if (task === 'solve' || task === 'retry') {
    return {
      system:
        'Write one C++17 program. It reads stdin and writes stdout. It has int main. It does not open files, spawn processes, or use the network. Reply with JSON only: {"source":"","approach":""}.',
      user: `Statement:\n${statement}\n\nCases:\n${cases}\n\nApproach note:\n${hint || 'Choose a correct approach.'}\n\nPrevious source:\n${source}\n\nPrevious result:\n${failure}`,
    };
  }
  if (task === 'fix') {
    return {
      system:
        'Fix the C++17 program so it compiles. Keep the same approach. Reply with JSON only: {"source":""}.',
      user: `Compiler output:\n${failure}\n\nSource:\n${source}`,
    };
  }
  return {
    system: 'Answer the question about this C++ file. Do not claim the file was edited. Reply with JSON only: {"text":""}.',
    user: `File:\n${source}\n\nQuestion:\n${clip(context.text, 4_000)}`,
  };
}

function createGemini({ apiKey, model, fetchImpl }) {
  const fetchFn = fetchImpl || fetch;
  return async function generate(task, context) {
    const built = promptFor(task, context);
    const parts = [{ text: built.user }];
    if (context.image) {
      parts.push({ inline_data: { mime_type: context.image.mime, data: context.image.data } });
    }
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
            generationConfig: {
              temperature: task === 'solve' || task === 'retry' ? 0.4 : 0.2,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          }),
          signal: AbortSignal.timeout(90_000),
        },
      );
    } catch {
      const error = new Error('The model request failed');
      error.status = 502;
      throw error;
    }
    if (!response.ok) {
      const error = new Error('The model request failed');
      error.status = 502;
      throw error;
    }
    const payload = await response.json();
    const chunks = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content
      ? payload.candidates[0].content.parts || []
      : [];
    const text = chunks
      .filter((part) => part && !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    return parseModelJson(redact(text, apiKey));
  };
}

function formatRun(result) {
  if (!result) return '';
  if (result.status === 'compile_error') {
    return `compile failed\n${clip(result.compile && result.compile.stderr, 2_000)}`;
  }
  return (result.cases || [])
    .map((item, index) => {
      const head = `case ${index + 1} ${item.status}${item.reason ? ` ${item.reason}` : ''}`;
      if (item.status === 'pass') return head;
      return `${head}\nexpected: ${clip(item.expected, 400)}\nactual: ${clip(item.actual, 400)}`;
    })
    .join('\n');
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
    running: false,
    statement: '',
    casesFromProblem: false,
    cases: [],
    source: '',
    approach: '',
    hint: '',
    pendingHint: '',
    stopForCases: false,
    messages: [],
    output: '',
    failure: '',
  };

  function say(text) {
    const clean = redact(clip(text, 4_000), secret);
    state.messages.push({ role: 'assistant', text: clean });
    if (state.messages.length > 40) state.messages.splice(0, state.messages.length - 40);
  }

  function noteOutput(text) {
    state.output = clip(`${state.output}${text}\n`, OUTPUT_LIMIT);
  }

  function snapshot() {
    return {
      configured: secret.length >= 20,
      phase: state.phase,
      messages: state.messages.map((item) => ({ role: item.role, text: item.text })),
      source: state.source || null,
      cases: state.cases.map((item, index) => ({
        input: item.input,
        expected: item.expected,
        actual: item.actual || '',
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

  async function writeAndRun(task) {
    let fixes = 0;
    for (let attempt = 1; attempt <= MAX_APPROACHES; attempt += 1) {
      const hint = state.pendingHint || state.hint;
      state.pendingHint = '';
      const written = await talk(task, {
        statement: state.statement,
        cases: state.cases,
        source: state.source,
        hint,
        failure: state.failure,
      });
      task = 'retry';
      if (!validSource(written.source, secret)) refuse(502, 'The model reply was not usable');
      state.source = written.source;
      state.approach = clip(written.approach, 1_000);
      if (state.approach) say(state.approach);
      say('Wrote the solution into the editor.');
      while (fixes < MAX_COMPILE_FIXES) {
        const result = await run(state.source, state.cases);
        const ran = result.cases || [];
        state.cases = state.cases.map((item, index) => ({
          input: item.input,
          expected: item.expected,
          actual: ran[index] ? ran[index].actual : '',
          status: result.status === 'compile_error' ? 'idle' : ran[index] ? ran[index].status : 'idle',
        }));
        const report = formatRun({ ...result, cases: state.cases.map((item, index) => ({ ...item, ...(result.cases[index] || {}) })) });
        noteOutput(report);
        state.failure = report;
        if (result.status === 'compile_error') {
          fixes += 1;
          say(`Compile failed. Fixing it (${fixes}/${MAX_COMPILE_FIXES}).`);
          const fixed = await talk('fix', { source: state.source, failure: result.compile.stderr });
          if (!validSource(fixed.source, secret)) refuse(502, 'The model reply was not usable');
          state.source = fixed.source;
          continue;
        }
        const failed = state.cases.some((item) => item.status !== 'pass');
        if (!failed) {
          state.phase = 'solved';
          say('All test cases passed.');
          return;
        }
        if (state.stopForCases) {
          state.phase = 'blocked';
          say('Stopping here. Tell me which expected output is wrong.');
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
          say('The answer is still wrong. Send an approach, or say the test cases are wrong.');
          return;
        }
        say('Wrong answer. The samples still match the statement, so I am trying another approach.');
        state.hint = state.pendingHint || 'Use a different algorithm than the previous attempt.';
        break;
      }
      if (fixes >= MAX_COMPILE_FIXES && state.phase !== 'solved') {
        state.phase = 'needs_human';
        say('It still does not compile. Send what you want changed.');
        return;
      }
    }
  }

  async function begin(input) {
    if (secret.length < 20) refuse(503, 'Agent is not configured');
    if (state.running) refuse(409, 'Agent is already working');
    const text = clip(input && input.text, 12_000);
    const image = input && input.image ? input.image : null;
    if (!text && !image) refuse(400, 'Send a question or an image');
    if (!imageOk(image)) refuse(400, 'Image must be a JPEG, PNG, or WebP under 4 MB');
    state.running = true;
    state.phase = 'working';
    state.statement = '';
    state.cases = [];
    state.source = '';
    state.failure = '';
    state.output = '';
    state.hint = clip(input.hint, 4_000);
    state.pendingHint = '';
    state.stopForCases = false;
    state.messages = [{ role: 'user', text: redact(text || 'Image attached', secret) }];
    try {
      const found = await talk('identify', { text, image, source: clip(input.source, SOURCE_LIMIT) });
      state.statement = clip(found.statement, 12_000);
      state.casesFromProblem = found.casesFromProblem === true;
      if (!state.statement) refuse(502, 'The model reply was not usable');
      say(state.statement);
      if (state.casesFromProblem) {
        if (!validCases(found.cases)) refuse(502, 'The model reply was not usable');
        state.cases = found.cases.map((item) => ({ input: item.input, expected: item.expected, actual: '', status: 'idle' }));
        say(`Using ${state.cases.length} sample case${state.cases.length === 1 ? '' : 's'} from the problem.`);
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
      } else {
        say('The problem has no sample cases. Writing some.');
        const made = await talk('makeCases', { statement: state.statement });
        if (!validCases(made.cases)) refuse(502, 'The model reply was not usable');
        state.cases = made.cases.slice(0, 4).map((item) => ({
          input: item.input,
          expected: item.expected,
          actual: '',
          status: 'idle',
        }));
      }
      if (found.plan) say(clip(found.plan, 1_000));
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
    const text = clip(input && input.text, 4_000);
    const action = input && input.action;
    if (state.running) {
      if (!text && action !== 'retry' && action !== 'cases_wrong') refuse(400, 'Send an approach or some context');
      if (action === 'cases_wrong') {
        state.stopForCases = true;
        say('I will stop after this run if the answer is wrong.');
        return snapshot();
      }
      state.pendingHint = action === 'retry' ? 'Try a different approach.' : text;
      say('I will use that on the next attempt.');
      return snapshot();
    }
    if (state.phase === 'idle') refuse(400, 'Start with a question or an image');
    if (action === 'cases_wrong' || /cases?.{0,40}wrong|wrong cases|samples?.{0,20}wrong/i.test(text)) {
      state.phase = 'blocked';
      say('I will not fit the program to those cases. Tell me which expected output is wrong.');
      return snapshot();
    }
    const hint = action === 'retry' ? 'Try a different approach than the one already written.' : text;
    if (!hint) refuse(400, 'Send an approach or some context');
    state.running = true;
    state.hint = hint;
    state.messages.push({ role: 'user', text: redact(state.hint, secret) });
    try {
      await writeAndRun('retry');
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

  return { begin, guide, ask, snapshot };
}

module.exports = {
  createAgentControl,
  createGemini,
  parseModelJson,
  imageOk,
  redact,
  MODEL,
};
