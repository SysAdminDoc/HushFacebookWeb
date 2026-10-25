import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSave } from '../src/core/download.js';
import { trackFile } from './helpers/mp4.js';

const parts = ['https://video.example.invalid/picture', 'https://video.example.invalid/sound'];
const doc = () => ({
  clicks: 0,
  body: { append() {} },
  createElement() {
    return { style: {}, click: () => { this.clicks++; }, remove() {} };
  },
});
const streamed = (chunks, headers = {}) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { status: 200, headers });

for (const headers of [{}, { 'Content-Length': '1' }]) {
  test(`DASH checks actual aggregate streamed bytes with ${Object.keys(headers).length ? 'false-small' : 'no'} Content-Length`, async () => {
    const signals = [];
    const page = doc();
    const win = { fetch(_url, { signal }) { signals.push(signal); return Promise.resolve(streamed([new Uint8Array(40), new Uint8Array(40)], headers)); } };
    await assert.rejects(startSave({ parts, name: 'a.mp4', win, doc: page, byteLimit: 120, deadline: 500 }).done, /transfer limit/i);
    assert.ok(signals.every((signal) => signal.aborted), 'both transfers stop');
    assert.equal(page.clicks, 0);
  });
}

test('DASH manager progress checks both parts together and stops both immediately', async () => {
  const requests = [];
  const stopped = [];
  const page = doc();
  const save = startSave({ parts, name: 'a.mp4', byteLimit: 100, deadline: 500, doc: page,
    api: { request(options) { requests.push(options); return { abort() { stopped.push(options.url); } }; } },
  });
  requests[0].onprogress?.({ loaded: 60 });
  requests[1].onprogress?.({ loaded: 60 });
  // Older code without a progress guard proceeds to parse these oversized buffers instead.
  for (const request of requests) request.onload({ status: 200, response: new ArrayBuffer(60) });
  await assert.rejects(save.done, /transfer limit/i);
  assert.deepEqual(new Set(stopped), new Set(parts));
  assert.equal(page.clicks, 0);
});

test('DASH final buffer sizes are checked even if manager progress understated them', async () => {
  const page = doc();
  await assert.rejects(startSave({ parts, name: 'a.mp4', byteLimit: 100, deadline: 500, doc: page,
    api: { request(options) {
      options.onprogress?.({ loaded: 1 });
      options.onload({ status: 200, response: new ArrayBuffer(60) });
      return { abort() {} };
    } },
  }).done, /transfer limit/i);
  assert.equal(page.clicks, 0);
});

test('a manager without bounded progress uses readable fetch for DASH', async () => {
  let managerCalls = 0;
  let fetchCalls = 0;
  const page = doc();
  const picture = trackFile();
  const sound = trackFile({ id: 2 });
  const win = { fetch(url) { fetchCalls++; return Promise.resolve(streamed([url === parts[0] ? picture : sound])); } };
  const how = await startSave({ parts, name: 'a.mp4', doc: page, win, byteLimit: picture.length + sound.length,
    api: { requestProgress: false, request() { managerCalls++; throw new Error('must not buffer in an unsupported manager'); } },
  }).done;
  assert.equal(how, 'link');
  assert.equal(managerCalls, 0);
  assert.equal(fetchCalls, 2);
  assert.equal(page.clicks, 1);
});

test('DASH refuses an unbounded fetch body without buffering it', async () => {
  let buffered = 0;
  const win = { fetch: async () => ({ ok: true, headers: new Headers(), arrayBuffer() { buffered++; return new ArrayBuffer(2); } }) };
  await assert.rejects(startSave({ parts, name: 'a.mp4', win, doc: doc(), deadline: 500 }).done, /stream/i);
  assert.equal(buffered, 0);
});

test('a synchronous second-part start failure cancels the part already started', async () => {
  let signal;
  const win = { fetch(url, options) {
    if (url === parts[1]) throw new Error('wrapped fetch refused');
    signal = options.signal;
    return new Promise(() => {});
  } };
  await assert.rejects(startSave({ parts, name: 'a.mp4', win, doc: doc() }).done, /wrapped fetch refused/);
  assert.equal(signal.aborted, true);
});

test('a manager abort throwing cannot leave the other DASH transfer running', async () => {
  const stopped = [];
  const save = startSave({ parts, name: 'a.mp4', doc: doc(), api: { request(options) {
    return { abort() { stopped.push(options.url); if (options.url === parts[0]) throw new Error('manager abort failed'); } };
  } } });
  save.cancel();
  await assert.rejects(save.done, (error) => error.cancelled === true);
  assert.deepEqual(stopped, parts);
});

test('a failed download-link handoff revokes its object URL', async (t) => {
  const made = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => { made.push('blob:probe'); return 'blob:probe'; });
  t.mock.method(URL, 'revokeObjectURL', (value) => revoked.push(value));
  const page = doc();
  page.body.append = () => { throw new Error('container ended'); };
  await assert.rejects(startSave({ url: parts[0], name: 'a.mp4', doc: page,
    api: { request: (options) => (options.onload({ status: 200, response: new Blob(['file']) }), { abort() {} }) },
  }).done, /container ended/);
  assert.deepEqual(revoked, made);
});
