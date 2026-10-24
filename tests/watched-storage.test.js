import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWatchedOperation, entriesOf, MAX_WATCHED, validWatchedOperation, WATCHED_KEY } from '../src/core/watched.js';
import { createWatchedJournal } from '../src/core/watched-journal.js';

const entry = (id, at) => ({ kind: 'video', id: String(id), at });
const key = `${WATCHED_KEY}@signed-out`;
const ids = (state) => entriesOf(state).map((item) => item.id);

test('watched deltas merge newest entries, cap deterministically, and retain a durable clear barrier', () => {
  let state = [entry(123456, 5)];
  state = applyWatchedOperation(state, { add: entry(234567, 10) });
  state = applyWatchedOperation(state, { add: entry(123456, 2) });
  assert.deepEqual(ids(state), ['234567', '123456']);
  state = applyWatchedOperation(state, { clear: 8 });
  state = applyWatchedOperation(structuredClone(state), { add: entry(345678, 7) });
  assert.deepEqual(ids(state), ['234567']);
  for (let i = 0; i < 60; i++) state = applyWatchedOperation(state, { add: entry(1000000 + i, 20) });
  assert.equal(entriesOf(state).length, MAX_WATCHED);
  assert.equal(entriesOf(state)[0].id, '1000059');
  for (const bad of [{}, { clear: 0 }, { clear: 5, add: entry(123456, 4) }, { add: { ...entry(123456, 4), secret: true } }]) {
    assert.equal(validWatchedOperation(bad), false);
  }
});

function managers(seed = {}) {
  const backend = new Map(Object.entries(structuredClone(seed)));
  const clients = [];
  const messages = [];
  const clone = (value) => structuredClone(value);
  return {
    backend,
    flush() {
      while (messages.length) {
        const [name, value, source] = messages.shift();
        for (const client of clients) {
          if (client === source) continue;
          if (value === undefined) client.cache.delete(name);
          else client.cache.set(name, clone(value));
        }
      }
    },
    client() {
      let serial = 0;
      const client = { cache: new Map([...backend].map(([name, value]) => [name, clone(value)])), fail: false, hold: null };
      clients.push(client);
      client.journal = createWatchedJournal({
        get: (name, fallback) => client.cache.has(name) ? clone(client.cache.get(name)) : fallback,
        list: () => [...client.cache.keys()],
        uuid: () => `client${clients.indexOf(client)}-${++serial}`,
        async set(name, value) {
          // Like VM, an equal cached value skips the request, and the cache changes before
          // the request can reject. Cross-origin notifications are intentionally delayed.
          if (JSON.stringify(client.cache.get(name)) === JSON.stringify(value)) return;
          client.cache.set(name, clone(value));
          if (client.fail) throw new Error('storage unavailable');
          if (client.hold && value.add) await client.hold;
          backend.set(name, clone(value));
          messages.push([name, clone(value), client]);
        },
        async remove(name) {
          if (client.fail) throw new Error('storage unavailable');
          client.cache.delete(name);
          backend.delete(name);
          messages.push([name, undefined, client]);
        },
      });
      return client;
    },
  };
}

test('independent cached GM tabs preserve distinct concurrent watches after delayed propagation', async () => {
  const platform = managers({ [key]: [entry(123456, 1)] });
  const a = platform.client();
  const b = platform.client();
  await Promise.all([a.journal.mutate(key, { add: entry(234567, 10) }), b.journal.mutate(key, { add: entry(345678, 20) })]);
  platform.flush();
  assert.deepEqual(ids(a.journal.read(key, [])), ['345678', '234567', '123456']);
  assert.deepEqual(ids(b.journal.read(key, [])), ['345678', '234567', '123456']);
});

test('a GM clear beats an older held write and survives a fresh manager cache', async () => {
  const platform = managers({ [key]: [entry(123456, 1)] });
  const a = platform.client();
  const b = platform.client();
  let release;
  a.hold = new Promise((resolve) => { release = resolve; });
  const older = a.journal.mutate(key, { add: entry(234567, 10) });
  await b.journal.mutate(key, { clear: 20 });
  release();
  await older;
  platform.flush();
  const restarted = platform.client();
  assert.deepEqual(ids(restarted.journal.read(key, [])), []);
  await restarted.journal.mutate(key, { add: entry(345678, 30) });
  assert.deepEqual(ids(restarted.journal.read(key, [])), ['345678']);
});

test('a rejected cache-first GM write stays unsaved and retries under a fresh physical key', async () => {
  const platform = managers();
  const client = platform.client();
  const operation = { add: entry(123456, 5) };
  client.fail = true;
  await assert.rejects(client.journal.mutate(key, operation), /unavailable/);
  assert.deepEqual(ids(client.journal.read(key, [])), []);
  client.fail = false;
  await client.journal.mutate(key, operation);
  assert.deepEqual(ids(platform.client().journal.read(key, [])), ['123456']);
});

test('GM pruning retains exactly the newest 50 watches and a maximum clear marker', async () => {
  const platform = managers();
  const client = platform.client();
  await client.journal.mutate(key, { clear: 1 });
  for (let i = 0; i < 60; i++) await client.journal.mutate(key, { add: entry(1000000 + i, i + 2) });
  assert.equal(entriesOf(client.journal.read(key, [])).length, 50);
  assert.equal([...platform.backend.keys()].filter((name) => name.startsWith(`${key}#watch:`)).length, 51);
});
