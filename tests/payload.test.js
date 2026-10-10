import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROP, createLineStream, friendlyNameOf, transformDocumentLine, transformText } from '../src/core/net/payload.js';

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
