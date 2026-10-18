// A re: line can't freeze the page. RE2JS matches in time linear in the text, where the
// browser's own RegExp backtracks. Every match here runs in a child process with a small heap
// and a hard timeout, so a pattern that does hang gets killed instead of the test run. The
// browser's RegExp on the same pattern and text is the positive control: it shows the timeout
// really catches a hang.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ENGINE = new URL('../src/core/filters/engine.js', import.meta.url).href;
const LIMIT_MS = 5000;

// Each pattern backtracks for hours on its text in a backtracking engine.
const CASES = [
  ['(a+)+$', `'a'.repeat(40) + '!'`],
  ['(a|aa)+$', `'a'.repeat(60) + '!'`],
  ['(x+x+)+y', `'x'.repeat(40)`],
  ['(.*a){12}$', `'a'.repeat(60) + '!'`],
];

function run(code) {
  return spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: LIMIT_MS, windowsHide: true,
  });
}

test('the browser RegExp hangs on a backtracking pattern until the timeout kills it', () => {
  const [source, text] = CASES[0];
  const result = run(`new RegExp(${JSON.stringify(source)}, 'iu').test(${text});`);
  assert.equal(result.error?.code, 'ETIMEDOUT', 'the positive control has to hang, or this file proves nothing');
});

test('re: lines answer the same backtracking patterns at once, on short texts and very long ones', () => {
  const code = `
    import { compileFilters } from ${JSON.stringify(ENGINE)};
    const cases = [${CASES.map(([source, text]) => `[${JSON.stringify(source)}, ${text}]`).join(', ')}];
    for (const [source, text] of cases) {
      const { rules, errors } = compileFilters('re:' + source);
      if (errors.length) throw new Error(source + ': ' + errors[0].message);
      for (const value of [text, text.slice(0, -1).repeat(1000) + text.at(-1)]) {
        if (rules[0].re.test(value) !== false) throw new Error(source + ' matched');
      }
    }
    console.log('ok');
  `;
  const result = run(code);
  assert.equal(result.error, undefined, 'RE2JS finished inside the timeout');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});
