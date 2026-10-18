import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP, FAILED, applyRules, createLineStream, friendlyNameOf, later, transformDocumentLine, transformText } from '../src/core/net/payload.js';

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
