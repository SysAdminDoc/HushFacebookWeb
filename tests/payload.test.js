import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP, FAILED, LINE_LIMIT, applyRules, createLineStream, friendlyNameOf, later, transformDocumentLine, transformText } from '../src/core/net/payload.js';

const rule = (transform, extra = {}) => ({ id: 'test', transform, ...extra });

test('an untouched line keeps its exact bytes', () => {
  const line = '{"data": {"a": 1},   "extensions":{}}';
  assert.equal(transformDocumentLine(line, [rule(() => undefined)]), line);
});

test('a changed document is re-serialized and keeps the for (;;); guard', () => {
  const line = 'for (;;);{"payload":{"x":1}}';
  const out = transformDocumentLine(line, [rule((doc) => { doc.payload.x = 2; return true; })]);
  assert.equal(out, 'for (;;);{"payload":{"x":2}}');
});

test('DROP removes the line', () => {
  assert.equal(transformDocumentLine('{"a":1}', [rule(() => DROP)]), null);
});

test('non-JSON and broken JSON lines pass through', () => {
  const spy = rule(() => true);
  assert.equal(transformDocumentLine('hello', [spy]), 'hello');
  assert.equal(transformDocumentLine('{"broken":', [spy]), '{"broken":');
});

test('rules with markers never parse text that lacks them', () => {
  let calls = 0;
  const marked = rule(() => { calls++; return true; }, { markers: ['"SPONSORED"'] });
  assert.equal(transformDocumentLine('{"category":"ORGANIC"}', [marked]), '{"category":"ORGANIC"}');
  assert.equal(calls, 0);
  transformDocumentLine('{"category":"SPONSORED"}', [marked]);
  assert.equal(calls, 1);
});

test('a throwing rule is reported and the line survives', () => {
  const errors = [];
  const bad = rule(() => { throw new Error('boom'); });
  const out = transformDocumentLine('{"a":1}', [bad], {}, (failed, error) => errors.push([failed.id, error.message]));
  assert.equal(out, '{"a":1}');
  assert.deepEqual(errors, [['test', 'boom']]);
});

test('a line a rule fails on goes out as it came, with no other edit, and the rules after it never run', () => {
  const errors = [];
  let after = 0;
  const line = 'for (;;);{"keep":1,"ad":{"x":1}}';
  const cut = rule((doc) => { delete doc.ad; return true; }, { id: 'cut' });
  const half = rule((doc) => { delete doc.keep; throw new Error('boom'); }, { id: 'half' });
  const next = rule(() => { after++; return true; }, { id: 'next' });
  assert.equal(transformDocumentLine(line, [cut, half, next], {}, (failed) => errors.push(failed.id)), line);
  assert.equal(after, 0);
  assert.deepEqual(errors, ['half']);
  assert.equal(transformDocumentLine(line, [cut, next], {}), 'for (;;);{"keep":1}', 'the same rules without the broken one still edit');
});

test('what a rule keeps waits for its document, and a later failure drops it and runs the undos', () => {
  const effects = [];
  const undone = [];
  const counting = rule((doc, ctx, stage) => { doc.n = 2; later(stage, () => effects.push('counted')); return true; });
  const book = rule((doc, ctx, stage) => { stage.undo(() => undone.push('first')); stage.undo(() => undone.push('second')); });
  const bad = rule(() => { throw new Error('x'); });
  assert.equal(transformDocumentLine('{"n":1}', [counting, book, bad]), '{"n":1}');
  assert.deepEqual(effects, []);
  assert.deepEqual(undone, ['second', 'first'], 'newest first');
  assert.equal(transformDocumentLine('{"n":1}', [counting, book]), '{"n":2}');
  assert.deepEqual(effects, ['counted']);
  assert.deepEqual(undone, ['second', 'first'], 'a pass that works undoes nothing');
  assert.equal(applyRules({}, [counting, rule(() => DROP)]), DROP);
  assert.deepEqual(effects, ['counted', 'counted'], 'a dropped document was taken out, so it counts');
  assert.equal(applyRules({}, [bad]), FAILED);
});

test('a rule run on its own, with no stage, keeps what it keeps at once', () => {
  let ran = false;
  later(undefined, () => { ran = true; });
  assert.equal(ran, true);
});

test('a queued effect that throws is reported, and the others still happen', () => {
  const errors = [];
  const effects = [];
  const first = rule((doc, ctx, stage) => { stage.defer(() => { throw new Error('count'); }); return true; }, { id: 'first' });
  const second = rule((doc, ctx, stage) => { stage.defer(() => effects.push('second')); }, { id: 'second' });
  assert.equal(transformDocumentLine('{"n":1}', [first, second], {}, (failed) => errors.push(failed.id)), '{"n":1}');
  assert.deepEqual(errors, ['first']);
  assert.deepEqual(effects, ['second']);
});

test('read-only rules see what the page gets: the edit when it worked, the original when a rule failed', () => {
  const seen = [];
  const watch = rule((doc) => { seen.push(JSON.stringify(doc)); return false; }, { id: 'watch', observe: true });
  const cut = rule((doc) => { delete doc.ad; return true; });
  const bad = rule(() => { throw new Error('x'); });
  transformDocumentLine('{"ad":1,"n":1}', [watch, cut]);
  transformDocumentLine('{"ad":1,"n":1}', [watch, cut, bad]);
  transformDocumentLine('{"ad":1,"n":1}', [watch, rule(() => DROP)]);
  assert.deepEqual(seen, ['{"n":1}', '{"ad":1,"n":1}'], 'a dropped line reaches no one');
});

const bump = (line) => transformDocumentLine(line, [rule((doc) => { if ('n' in doc) { doc.n += 1; return true; } return undefined; })]);
const dropOdd = (line) => transformDocumentLine(line, [rule((doc) => (doc.n % 2 ? DROP : undefined))]);

test('stream output is the same wherever the body is split', () => {
  const body = '{"n":1}\r\n{"n":2}\n\n{"other":true}\n{"n":3}';
  const whole = transformText(body, bump);
  assert.equal(whole, '{"n":2}\r\n{"n":3}\n\n{"other":true}\n{"n":4}');
  for (let i = 0; i <= body.length; i++) {
    const stream = createLineStream(bump);
    const first = stream.push(body.slice(0, i));
    const rest = stream.push(body.slice(i)) + stream.flush();
    assert.equal(first + rest, whole, `split at ${i}`);
    assert.ok(whole.startsWith(first), `prefix at ${i}`);
  }
});

test('stream holds back a partial line until it completes', () => {
  const stream = createLineStream(bump);
  assert.equal(stream.push('{"n":1'), '');
  assert.equal(stream.push('}\n{"n"'), '{"n":2}\n');
  assert.equal(stream.flush(), '{"n"');
});

test('in a stream, only the line a rule fails on goes out as it came', () => {
  const failOnBad = (line) => transformDocumentLine(line, [
    rule((doc) => { doc.n += 1; return true; }),
    rule((doc) => { if (doc.bad) throw new Error('bad'); }),
  ]);
  const body = '{"n":1}\n{"n":2,"bad":1}\n{"n":3}';
  const whole = transformText(body, failOnBad);
  assert.equal(whole, '{"n":2}\n{"n":2,"bad":1}\n{"n":4}');
  for (let i = 0; i <= body.length; i++) {
    const stream = createLineStream(failOnBad);
    const first = stream.push(body.slice(0, i));
    assert.ok(whole.startsWith(first), `prefix at ${i}`);
    assert.equal(first + stream.push(body.slice(i)) + stream.flush(), whole, `split at ${i}`);
  }
});

test('a line past the limit goes out as it came wherever the body is split, and the lines around it are still edited', () => {
  // Accents and an emoji, so splits land inside multibyte characters and surrogate pairs. Each
  // long line has its own n, which bump would change if it were ever parsed.
  const long = `{"n":1,"pad":"${'é😀x'.repeat(6)}"}`;
  const body = `{"n":1}\r\n${long}\r\n{"n":5}\n${long}`;
  const expected = `{"n":2}\r\n${long}\r\n{"n":6}\n${long}`;
  const limit = 20;
  for (let i = 0; i <= body.length; i++) {
    for (let j = i; j <= body.length; j += 5) {
      const parsed = [];
      let bypassed = 0;
      const stream = createLineStream((line) => { parsed.push(line); return bump(line); }, { limit, onBypass: () => bypassed++ });
      let out = '';
      for (const part of [body.slice(0, i), body.slice(i, j), body.slice(j)]) {
        const piece = stream.push(part);
        assert.ok(stream.held <= limit, `held ${stream.held} at ${i}, ${j}`);
        out += piece;
        assert.ok(expected.startsWith(out), `prefix at ${i}, ${j}`);
      }
      out += stream.flush();
      assert.equal(out, expected, `split at ${i}, ${j}`);
      assert.equal(bypassed, 2, `counted once each at ${i}, ${j}`);
      assert.deepEqual(parsed, ['{"n":1}', '{"n":5}'], `long lines never parsed at ${i}, ${j}`);
    }
  }
});

test('a long line given up partway leaves nothing held, however much of it came first', () => {
  let bypassed = 0;
  const stream = createLineStream(() => assert.fail('a line past the limit is never parsed'), { limit: 64, onBypass: () => bypassed++ });
  let out = stream.push('{"a":"');
  let most = 0;
  for (let i = 0; i < 1000; i++) {
    out += stream.push('y'.repeat(50));
    most = Math.max(most, stream.held);
  }
  assert.ok(most <= 64, `held at most ${most}`);
  assert.equal(stream.held, 0, 'an abort here keeps nothing');
  assert.equal(out, `{"a":"${'y'.repeat(50000)}`);
  assert.equal(stream.flush(), '', 'nothing is left to flush');
  assert.equal(bypassed, 1);
});

test('with the default limit a 24 MiB line streams through while holding at most LINE_LIMIT', () => {
  const piece = 'z'.repeat(256 * 1024);
  let bypassed = 0;
  const stream = createLineStream(() => assert.fail('never parsed'), { onBypass: () => bypassed++ });
  let most = 0;
  let length = stream.push('{"pad":"').length;
  for (let i = 0; i < 96; i++) {
    length += stream.push(piece).length;
    most = Math.max(most, stream.held);
  }
  length += stream.push('"}\n').length;
  assert.ok(most <= LINE_LIMIT, `held at most ${most}`);
  assert.equal(length, 96 * piece.length + '{"pad":"'.length + '"}\n'.length);
  assert.equal(bypassed, 1);
  assert.equal(stream.held, 0);
});

test('dropped lines take their line break with them', () => {
  assert.equal(transformText('{"n":1}\n{"n":2}\n{"n":3}\n', dropOdd), '{"n":2}\n');
});

test('friendlyNameOf reads headers and every body shape', () => {
  assert.equal(friendlyNameOf(undefined, { 'X-FB-Friendly-Name': 'FromHeader' }), 'FromHeader');
  assert.equal(friendlyNameOf(undefined, new Headers({ 'x-fb-friendly-name': 'FromHeaders' })), 'FromHeaders');
  assert.equal(friendlyNameOf(undefined, [['x-fb-friendly-name', 'FromArray']]), 'FromArray');
  assert.equal(friendlyNameOf('av=1&fb_api_req_friendly_name=CometNewsFeedPaginationQuery&doc_id=2'), 'CometNewsFeedPaginationQuery');
  assert.equal(friendlyNameOf(new URLSearchParams({ fb_api_req_friendly_name: 'FromParams' })), 'FromParams');
  const form = new FormData();
  form.set('fb_api_req_friendly_name', 'FromForm');
  assert.equal(friendlyNameOf(form), 'FromForm');
  assert.equal(friendlyNameOf('{"json":true}'), '');
  assert.equal(friendlyNameOf(null), '');
});
