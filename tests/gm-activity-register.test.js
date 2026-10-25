import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createGmActivityRegister, gmActivityRegisterKey, gmActivityPulseKey,
  GM_ACTIVITY_MAX_RECORDS, GM_ACTIVITY_MAX_BYTES,
} from '../src/core/gm-activity-register.js';

const SPEED = 'keepSpeed.rate';
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, structuredClone(value)]));

function page(backend, label, { now = () => 100, uuid } = {}) {
  const cache = cloneMap(backend);
  const calls = [];
  const timers = [];
  let sequence = 0;
  const controls = { rejectProposal: 0, rejectRaw: 0, rejectPulse: false, rejectCleanup: false, allow: true, hold: null };
  const register = createGmActivityRegister({
    get(key, fallback) { calls.push(['get', key]); return cache.has(key) ? structuredClone(cache.get(key)) : fallback; },
    list() { calls.push(['list']); return [...cache.keys()]; },
    async set(key, value) {
      calls.push(['set', key, structuredClone(value)]);
      cache.set(key, structuredClone(value)); // The manager mutates its local cache before acknowledgement.
      if (key.includes('#activity:') && controls.rejectProposal-- > 0) throw new Error('manager unavailable');
      if (key === SPEED && controls.rejectRaw-- > 0) throw new Error('manager unavailable');
      if (key === gmActivityPulseKey(SPEED) && controls.rejectPulse) throw new Error('pulse unavailable');
      if (controls.hold && key.includes('#activity:')) await controls.hold;
      backend.set(key, structuredClone(value));
    },
    async remove(key) {
      calls.push(['remove', key]);
      if (controls.rejectCleanup) throw new Error('cleanup unavailable');
      cache.delete(key);
      backend.delete(key);
    },
    uuid: uuid ?? (() => `${label}-${++sequence}`), now,
    schedule(run, delay) { const timer = { run, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel(timer) { timer.cancelled = true; },
    log: { warn() {}, error() {} },
  });
  return {
    register, cache, calls, controls, timers,
    sync() { cache.clear(); for (const [key, value] of backend) cache.set(key, structuredClone(value)); },
    async next() {
      await tick();
      const timer = timers.find((item) => !item.cancelled && !item.ran);
      assert.ok(timer, 'an automatic retry was scheduled');
      timer.ran = true;
      timer.run();
      await tick();
    },
  };
}

const physicalWrites = (p) => p.calls.filter(([method, key]) => method === 'set' && key.includes('#activity:'));
let freshSequence = 0;
const fresh = (backend) => page(backend, `fresh-${++freshSequence}`).register;

test('the register namespace includes raw legacy seen keys and ordinary scoped playback, not watched or scoped seen', () => {
  for (const key of ['seenPosts', 'seenPostsCleared', SPEED, 'keepVolume.state', 'resumeVideos.positions@signed-out', `${SPEED}@${'a'.repeat(32)}`]) assert.equal(gmActivityRegisterKey(key), true, key);
  for (const key of ['settings', 'seenPosts@signed-out', `seenPostsCleared@${'a'.repeat(32)}`, 'rememberWatched.list', `${SPEED}@account`, null]) assert.equal(gmActivityRegisterKey(key), false, key);
});

test('legacy raw values remain readable and ordinary nonce epochs invalidate earlier proposals', async () => {
  const backend = new Map([[SPEED, 1.25]]);
  const p = page(backend, 'a');
  assert.equal(p.register.read(SPEED), 1.25);
  await p.register.write(SPEED, 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  await p.register.set(SPEED, 2);
  assert.equal(fresh(backend).read(SPEED), 2);
  const epoch = structuredClone(backend.get(SPEED));
  await p.register.set(SPEED, 2); // Identical logical bytes still have a different physical generation.
  assert.notEqual(backend.get(SPEED).nonce, epoch.nonce);
  assert.equal(fresh(backend).read(SPEED), 2);
  await p.register.remove(SPEED);
  assert.equal(backend.get(SPEED).deleted, true);
  assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone');
});

test('cache-first rejection stays invisible and automatic retry uses a fresh key with the original logical identity', async () => {
  const backend = new Map([[SPEED, 1.25]]);
  const p = page(backend, 'a');
  p.controls.rejectProposal = 1;
  p.controls.rejectCleanup = true;
  const saved = p.register.write(SPEED, 1.5);
  await tick();
  assert.equal(p.register.read(SPEED), 1.25, 'the rejected cache-only record is not an acknowledged value');
  assert.equal(fresh(backend).read(SPEED), 1.25);
  await p.next();
  assert.equal(await saved, 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  const writes = physicalWrites(p);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0][1], writes[1][1]);
  assert.deepEqual(writes[0][2], writes[1][2], 'retries keep the operation id, parents, epoch and original time');
  assert.equal(backend.get(SPEED), 1.25, 'repair never replaces or removes the raw seed');
});

test('automatic retries are bounded and a later manual retry retains the same failed intent', async () => {
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a');
  p.controls.rejectProposal = 3;
  p.controls.rejectCleanup = true;
  const failed = p.register.write(SPEED, 1.5);
  await p.next();
  await p.next();
  await assert.rejects(failed, /manager unavailable/);
  assert.deepEqual(p.timers.map((timer) => timer.delay), [250, 1000]);
  assert.equal(physicalWrites(p).length, 3);
  assert.equal(p.register.read(SPEED), 1);
  await p.register.write(SPEED, 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  const writes = physicalWrites(p);
  assert.equal(new Set(writes.map(([, , op]) => op.id)).size, 1);
  assert.equal(new Set(writes.map(([, name]) => name)).size, 4);
});

test('a raw ordinary value committed before a stale repair retry survives fresh reopen', async () => {
  const backend = new Map([[SPEED, 1.25]]);
  const old = page(backend, 'a');
  old.controls.rejectProposal = 1;
  old.controls.rejectCleanup = true;
  const restoring = old.register.write(SPEED, 1.5);
  await tick();
  const other = page(backend, 'b');
  await other.register.set(SPEED, 2);
  await old.next(); // Keep the old page's remote updates held throughout the retry.
  await restoring;
  assert.equal(fresh(backend).read(SPEED), 2);
  assert.equal(backend.get(SPEED).value, 2);
  assert.equal(old.calls.filter(([method, key]) => ['set', 'remove'].includes(method) && key === SPEED).length, 0);
});

test('concurrent different-value repairs remain recoverable instead of choosing a clock or UUID winner', async () => {
  for (const otherTime of [100, 5]) {
    for (const propagate of [false, true]) {
      const backend = new Map([[SPEED, 1.25]]);
      const old = page(backend, 'z', { now: () => 100 });
      const other = page(backend, 'a', { now: () => otherTime });
      old.controls.rejectProposal = 1;
      old.controls.rejectCleanup = true;
      const retrying = old.register.write(SPEED, 1.5);
      await tick();
      await other.register.write(SPEED, 2);
      assert.equal(fresh(backend).read(SPEED), 2);
      if (propagate) old.sync();
      await old.next();
      if (propagate) await assert.rejects(retrying, { code: 'ACTIVITY_REGISTER_CONFLICT' });
      else await retrying; // An acknowledgement cannot observe a deliberately held remote update.
      assert.throws(() => fresh(backend).read(SPEED), { code: 'ACTIVITY_REGISTER_CONFLICT' });
      assert.deepEqual([...backend.values()].filter((value) => value?.kind === 'set').map((value) => value.value).sort(), [1.5, 2]);
      old.sync();
      await old.register.write(SPEED, 2); // An explicit retry observes both heads and resolves them causally.
      assert.equal(fresh(backend).read(SPEED), 2);
    }
  }
});

test('two retried competing repairs have the same explicit conflict limit', async () => {
  const backend = new Map([[SPEED, 1.25]]);
  const old = page(backend, 'z', { now: () => 100 });
  const other = page(backend, 'a', { now: () => 5 });
  old.controls.rejectProposal = 1;
  other.controls.rejectProposal = 1;
  const oldRetry = old.register.write(SPEED, 1.5);
  const otherRetry = other.register.write(SPEED, 2);
  await other.next();
  await otherRetry;
  assert.equal(fresh(backend).read(SPEED), 2);
  await old.next();
  await oldRetry;
  assert.throws(() => fresh(backend).read(SPEED), { code: 'ACTIVITY_REGISTER_CONFLICT' });
  await fresh(backend).set(SPEED, 2.5);
  assert.equal(fresh(backend).read(SPEED), 2.5);
});

test('unobserved set and erase branches conflict until an explicit causal choice resolves them', async () => {
  for (const eraseFirst of [true, false]) {
    const backend = new Map([[SPEED, 1.25]]);
    const old = page(backend, 'z', { now: () => 100 });
    const other = page(backend, 'a', { now: () => 5 });
    old.controls.rejectProposal = 1;
    const pending = eraseFirst ? old.register.erase(SPEED) : old.register.write(SPEED, 1.5);
    await tick();
    const otherToken = eraseFirst ? await other.register.write(SPEED, 2) : await other.register.erase(SPEED);
    assert.equal(fresh(backend).read(SPEED), eraseFirst ? 2 : undefined);
    await old.next();
    const oldToken = await pending;
    assert.throws(() => fresh(backend).read(SPEED), { code: 'ACTIVITY_REGISTER_CONFLICT' });
    const reader = fresh(backend);
    await reader.write(SPEED, 1.25, { restoreFrom: eraseFirst ? oldToken : otherToken });
    assert.equal(fresh(backend).read(SPEED), eraseFirst ? 2 : 1.5, 'undoing the erase keeps the unrelated set');
    const deletion = await fresh(backend).erase(SPEED);
    assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone', 'a proven causally later erase applies normally');
    await fresh(backend).write(SPEED, 2.5, { restoreFrom: deletion });
    assert.equal(fresh(backend).read(SPEED), 2.5);
  }
});

test('agreeing concurrent repairs converge without clock or enumeration order deciding their value', async () => {
  const backend = new Map([[SPEED, 1]]);
  const first = page(backend, 'z', { now: () => 100 });
  const other = page(backend, 'a', { now: () => 5 });
  await first.register.write(SPEED, 1.5);
  await other.register.write(SPEED, 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  assert.equal(fresh(new Map([...backend].reverse())).read(SPEED), 1.5);
});

test('conflicting recovery exposes a detached acknowledged source for an explicit choice', async () => {
  const key = 'keepVolume.state';
  const baseline = { volume: 0.5, muted: false };
  const backend = new Map([[key, baseline]]);
  const first = page(backend, 'z');
  const other = page(backend, 'a');
  await first.register.write(key, { volume: 0.25, muted: true });
  await other.register.write(key, { volume: 0.75, muted: false });
  const reader = fresh(backend);
  assert.throws(() => reader.read(key), { code: 'ACTIVITY_REGISTER_CONFLICT' });
  const source = reader.source(key);
  assert.deepEqual(source, baseline);
  source.volume = 0.99;
  assert.deepEqual(reader.source(key), baseline);
  await reader.write(key, reader.source(key));
  assert.deepEqual(fresh(backend).read(key), baseline);
});

test('legacy erase is a durable logical tombstone and Undo names that exact deletion', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const p = page(backend, 'a');
  const deletion = await p.register.erase(SPEED);
  assert.equal(typeof deletion, 'string');
  assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone');
  assert.equal(backend.get(SPEED), 1.5, 'the original seed stays untouched for recovery and cannot be blind-purged');
  await p.register.write(SPEED, 1.5, { restoreFrom: deletion });
  assert.equal(fresh(backend).read(SPEED), 1.5);
});

test('each concurrent deletion needs its own Undo and all agreeing Undos recover the value', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const first = page(backend, 'z');
  const other = page(backend, 'a');
  const third = page(backend, 'third');
  first.controls.rejectProposal = 1;
  const firstDeleted = first.register.erase(SPEED);
  const otherToken = await other.register.erase(SPEED);
  await first.next();
  const firstToken = await firstDeleted;
  await first.register.write(SPEED, 1.5, { restoreFrom: firstToken });
  assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone', 'the other concurrent deletion is still active');
  await other.register.write(SPEED, 1.5, { restoreFrom: otherToken });
  assert.equal(fresh(backend).read(SPEED), 1.5, 'both deletion tokens have been undone');
  const thirdToken = await third.register.erase(SPEED);
  assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone', 'a genuinely un-undone concurrent deletion stays active');
  await third.register.write(SPEED, 1.5, { restoreFrom: thirdToken });
  assert.equal(fresh(backend).read(SPEED), 1.5);
  await fresh(backend).write(SPEED, 2);
  assert.equal(fresh(backend).read(SPEED), 2, 'a causally later unrelated value stays current');
});

test('observing another deletion Undo does not revoke its cancellation', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const first = page(backend, 'z');
  const other = page(backend, 'a');
  const firstToken = await first.register.erase(SPEED);
  const otherToken = await other.register.erase(SPEED);
  first.sync();
  await first.register.write(SPEED, 1.5, { restoreFrom: firstToken });
  assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone');
  other.sync();
  await other.register.write(SPEED, 1.5, { restoreFrom: otherToken });
  assert.equal(fresh(backend).read(SPEED), 1.5);
});

test('divergent concurrent Undos retain both choices and surface the same conflict limit', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const first = page(backend, 'z');
  const other = page(backend, 'a');
  const firstToken = await first.register.erase(SPEED);
  const otherToken = await other.register.erase(SPEED);
  first.sync();
  other.sync();
  await first.register.write(SPEED, 1.5, { restoreFrom: firstToken });
  await other.register.write(SPEED, 2, { restoreFrom: otherToken });
  const reader = fresh(backend);
  assert.throws(() => reader.read(SPEED), { code: 'ACTIVITY_REGISTER_CONFLICT' });
  assert.equal(reader.source(SPEED), 1.5);
  await reader.set(SPEED, 2.5);
  assert.equal(fresh(backend).read(SPEED), 2.5);
});

test('a restore loses a concurrent unrelated confirmed proposal even with tied clocks and reversed id rank', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const eraser = page(backend, 'z');
  const deletion = await eraser.register.erase(SPEED);
  const restoring = page(backend, 'r');
  const unrelated = page(backend, 'a');
  restoring.controls.rejectProposal = 1;
  restoring.controls.rejectCleanup = true;
  const undo = restoring.register.write(SPEED, 1.5, { restoreFrom: deletion });
  await tick();
  await unrelated.register.write(SPEED, 2);
  await restoring.next();
  await undo;
  assert.equal(fresh(backend).read(SPEED), 2);
});

test('a later deletion and a later ordinary tombstone cannot be undone by a delayed old restore', async () => {
  for (const ordinary of [false, true]) {
    const backend = new Map([[SPEED, 1.5]]);
    const first = page(backend, 'a');
    const deletion = await first.register.erase(SPEED);
    const restore = page(backend, 'b');
    restore.controls.rejectProposal = 1;
    restore.controls.rejectCleanup = true;
    const undone = restore.register.write(SPEED, 1.5, { restoreFrom: deletion });
    await tick();
    const later = page(backend, 'c');
    if (ordinary) await later.register.remove(SPEED);
    else await later.register.erase(SPEED);
    await restore.next();
    await undone;
    assert.equal(fresh(backend).read(SPEED, 'gone'), 'gone', ordinary ? 'new epoch' : 'new deletion token');
  }
});

test('a restore cannot target another epoch or an unknown deletion', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const p = page(backend, 'a');
  const deletion = await p.register.erase(SPEED);
  await p.register.set(SPEED, 2);
  await p.register.write(SPEED, 1.5, { restoreFrom: deletion });
  assert.equal(fresh(backend).read(SPEED), 2);
  await p.register.write(SPEED, 4, { restoreFrom: 'unknown-deletion' });
  assert.equal(fresh(backend).read(SPEED), 2);
});

test('duplicate physical records have one logical effect and projections ignore physical delivery order', async () => {
  const backend = new Map([[SPEED, 1.5]]);
  const p = page(backend, 'a');
  const deletion = await p.register.erase(SPEED);
  await p.register.write(SPEED, 1.5, { restoreFrom: deletion });
  const record = [...backend].find(([key, value]) => key.includes('#activity:') && value.kind === 'restore');
  backend.set(`${SPEED}#activity:duplicate`, structuredClone(record[1]));
  const expected = fresh(backend).read(SPEED);
  assert.equal(expected, 1.5);
  assert.equal(fresh(new Map([...backend].reverse())).read(SPEED), expected);
  assert.equal(fresh(new Map([...backend].sort((a, b) => a[0].localeCompare(b[0])))).read(SPEED), expected);
});

test('an account switch before retry cancels saving and disallowed contexts touch no persistent API', async () => {
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a');
  p.controls.rejectProposal = 1;
  const saving = p.register.write(SPEED, 1.5, { allowed: () => p.controls.allow });
  await tick();
  p.controls.allow = false;
  const before = p.calls.filter(([method]) => ['set', 'remove'].includes(method)).length;
  await p.next();
  await assert.rejects(saving, { code: 'ACTIVITY_ACCOUNT_CHANGED' });
  assert.equal(p.calls.filter(([method]) => ['set', 'remove'].includes(method)).length, before);
  for (const context of ['private', 'unknown']) {
    const isolated = page(backend, context);
    assert.throws(() => isolated.register.write(SPEED, 2, { allowed: () => false }), { code: 'ACTIVITY_ACCOUNT_CHANGED' });
    assert.throws(() => isolated.register.erase(SPEED, { allowed: () => false }), { code: 'ACTIVITY_ACCOUNT_CHANGED' });
    assert.throws(() => isolated.register.set(SPEED, 2, { allowed: () => false }), { code: 'ACTIVITY_ACCOUNT_CHANGED' });
    assert.throws(() => isolated.register.remove(SPEED, { allowed: () => false }), { code: 'ACTIVITY_ACCOUNT_CHANGED' });
    assert.deepEqual(isolated.calls, []);
  }
});

test('an account switch during acknowledgement stops before the notification write', async () => {
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a');
  let release;
  p.controls.hold = new Promise((resolve) => { release = resolve; });
  const saved = p.register.write(SPEED, 1.5, { allowed: () => p.controls.allow });
  await tick();
  p.controls.allow = false;
  release();
  await assert.rejects(saved, { code: 'ACTIVITY_ACCOUNT_CHANGED' });
  assert.equal(p.calls.some(([method, key]) => method === 'set' && key === gmActivityPulseKey(SPEED)), false);
  assert.equal(physicalWrites(p).length, 1);
});

test('a rejected ordinary cache-only epoch stays hidden and is never automatically retried over newer data', async () => {
  const backend = new Map([[SPEED, 1.25]]);
  const p = page(backend, 'a');
  p.controls.rejectRaw = 1;
  await assert.rejects(p.register.set(SPEED, 1.5), /manager unavailable/);
  assert.equal(p.register.read(SPEED), 1.25);
  assert.equal(p.register.source(SPEED), 1.25, 'recovery never treats a rejected cache-only epoch as its source');
  assert.equal(fresh(backend).read(SPEED), 1.25);
  const other = page(backend, 'b');
  await other.register.set(SPEED, 2);
  assert.equal(p.timers.length, 0);
  p.sync();
  assert.equal(p.register.read(SPEED), 2);
  p.controls.rejectRaw = 1;
  await assert.rejects(p.register.set(SPEED, 3), /manager unavailable/);
  assert.equal(p.register.read(SPEED), 2, 'a new failed epoch keeps the foreign acknowledged value');
});

test('subscriber refresh reports projected values and a failed pulse does not invalidate an acknowledged proposal', async () => {
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a');
  const heard = [];
  const off = p.register.subscribe(SPEED, (value, info) => heard.push([value, info.source]));
  p.controls.rejectPulse = true;
  await p.register.write(SPEED, 1.5);
  assert.deepEqual(heard, [[1.5, 'ack']]);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  off();
  p.register.refresh(SPEED);
  assert.equal(heard.length, 1);
});

test('overlapping ordinary failures reveal the most recent acknowledged epoch, not an older fallback', async () => {
  const backend = new Map([[SPEED, 1]]);
  const cache = cloneMap(backend);
  const writes = [];
  let ids = 0;
  const register = createGmActivityRegister({
    get: (key, fallback) => cache.has(key) ? structuredClone(cache.get(key)) : fallback,
    list: () => [...cache.keys()],
    set(key, value) {
      cache.set(key, structuredClone(value));
      return new Promise((resolve, reject) => writes.push({
        accept() { backend.set(key, structuredClone(value)); resolve(); }, reject,
      }));
    },
    remove() {}, uuid: () => `overlap-${++ids}`, log: { error() {} },
  });
  const first = register.set(SPEED, 1.5);
  const second = register.set(SPEED, 2);
  writes[0].accept();
  await first;
  writes[1].reject(new Error('second epoch rejected'));
  await assert.rejects(second, /second epoch rejected/);
  assert.equal(register.read(SPEED), 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
});

test('settled ordinary failures release their old payloads while retaining the recoverable value', async () => {
  if (typeof globalThis.gc !== 'function') {
    assert.notEqual(process.env.HFW_GM_REGISTER_GC, '1', 'the memory probe must inherit --expose-gc');
    const child = spawnSync(process.execPath, [
      '--expose-gc', '--test', '--test-name-pattern=^settled ordinary failures release', fileURLToPath(import.meta.url),
    ], { env: { ...process.env, HFW_GM_REGISTER_GC: '1' }, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const key = 'keepVolume.state';
  const originalClone = globalThis.structuredClone;
  const cache = new Map([[key, { volume: 0.5, muted: false }]]);
  const initialInput = { volume: 0.1, muted: false };
  let firstClone;
  let sequence = 0;
  globalThis.structuredClone = (value) => {
    const result = originalClone(value);
    if (value === initialInput) firstClone = new WeakRef(result);
    return result;
  };
  const register = createGmActivityRegister({
    get: (name, fallback) => cache.has(name) ? originalClone(cache.get(name)) : fallback,
    list: () => [...cache.keys()],
    async set(name, value) { cache.set(name, originalClone(value)); throw new Error('offline'); },
    remove() {}, uuid: () => `retention-${++sequence}`, log: { error() {} },
  });
  try {
    for (let i = 0; i < 128; i++) {
      await assert.rejects(register.set(key, i === 0 ? initialInput : { volume: (i % 10) / 10, muted: false }), /offline/);
    }
  } finally { globalThis.structuredClone = originalClone; }
  assert.ok(firstClone, 'the first rejected epoch supplied a tracked payload');
  await new Promise(setImmediate);
  let collected = false;
  for (let i = 0; i < 8; i++) {
    globalThis.gc();
    await new Promise(setImmediate);
    if (firstClone.deref() === undefined) { collected = true; break; }
    await new Promise(setImmediate);
  }
  assert.ok(collected, 'settled failures must not retain all older failed payloads');
  assert.deepEqual(register.read(key), { volume: 0.5, muted: false });
});

test('collapsing settled failures retains an earlier in-flight epoch until it acknowledges', async () => {
  const backend = new Map([[SPEED, 1]]);
  const cache = cloneMap(backend);
  const writes = [];
  let sequence = 0;
  const register = createGmActivityRegister({
    get: (key, fallback) => cache.has(key) ? structuredClone(cache.get(key)) : fallback,
    list: () => [...cache.keys()],
    set(key, value) {
      cache.set(key, structuredClone(value));
      return new Promise((resolve, reject) => writes.push({
        accept() { backend.set(key, structuredClone(value)); resolve(); }, reject,
      }));
    },
    remove() {}, uuid: () => `late-ack-${++sequence}`, log: { error() {} },
  });
  const first = register.set(SPEED, 1.5);
  const second = register.set(SPEED, 2);
  const third = register.set(SPEED, 2.5);
  writes[1].reject(new Error('second failed'));
  await assert.rejects(second, /second failed/);
  writes[2].reject(new Error('third failed'));
  await assert.rejects(third, /third failed/);
  assert.equal(register.read(SPEED), 1);
  writes[0].accept();
  await first;
  assert.equal(register.read(SPEED), 1.5);
  assert.equal(fresh(backend).read(SPEED), 1.5);
});

test('partial multi-key restoration retains acknowledged earlier keys and safely retries the failed key', async () => {
  const VOLUME = 'keepVolume.state';
  const backend = new Map([[SPEED, 1.5], [VOLUME, { volume: 0.5, muted: false }]]);
  const p = page(backend, 'a');
  const speedDeleted = await p.register.erase(SPEED);
  const volumeDeleted = await p.register.erase(VOLUME);
  await p.register.write(SPEED, 1.5, { restoreFrom: speedDeleted });
  p.controls.rejectProposal = 3;
  const firstVolume = p.register.write(VOLUME, { volume: 0.5, muted: false }, { restoreFrom: volumeDeleted });
  await p.next();
  await p.next();
  await assert.rejects(firstVolume, /manager unavailable/);
  assert.equal(fresh(backend).read(SPEED), 1.5);
  assert.equal(fresh(backend).read(VOLUME, 'gone'), 'gone');
  await p.register.write(VOLUME, { volume: 0.5, muted: false }, { restoreFrom: volumeDeleted });
  assert.deepEqual(fresh(backend).read(VOLUME), { volume: 0.5, muted: false });
});

test('a changed legacy raw seed invalidates old proposals without replacing the newer seed', async () => {
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a');
  await p.register.write(SPEED, 1.5);
  backend.set(SPEED, 3);
  assert.equal(fresh(backend).read(SPEED), 3);
  assert.equal(backend.get(SPEED), 3);
});

test('causal ordinary proposals win observed predecessors even when the clock moves backwards', async () => {
  let at = 100;
  const backend = new Map([[SPEED, 1]]);
  const p = page(backend, 'a', { now: () => at });
  await p.register.write(SPEED, 1.5);
  at = 5;
  await p.register.write(SPEED, 2);
  assert.equal(fresh(backend).read(SPEED), 2);
});

test('malformed or conflicting records are ignored and returned values are detached', async () => {
  const backend = new Map([['keepVolume.state', { volume: 0.5, muted: false }]]);
  const p = page(backend, 'a');
  backend.set('keepVolume.state#activity:bad', { tag: 'hfw-activity-v1', seed: 'undefined', parents: [], kind: 'set', at: 0, value: 1 });
  p.sync();
  const value = p.register.read('keepVolume.state');
  value.volume = 1;
  assert.equal(p.register.read('keepVolume.state').volume, 0.5);
  await p.register.write('keepVolume.state', { volume: 0.25, muted: true });
  const [name, operation] = [...backend].find(([key, value]) => key.includes('#activity:') && value.id);
  backend.set(`${name}-conflict`, { ...operation, value: { volume: 0.75, muted: false } });
  assert.deepEqual(fresh(backend).read('keepVolume.state'), { volume: 0.5, muted: false });
});

test('record and byte limits refuse further rare repairs without compacting ordering evidence or blocking ordinary epochs', async () => {
  for (const large of [false, true]) {
    const backend = new Map([[SPEED, 1]]);
    if (large) backend.set(`${SPEED}#activity:oversized`, { ignored: 'x'.repeat(GM_ACTIVITY_MAX_BYTES) });
    else for (let i = 0; i < GM_ACTIVITY_MAX_RECORDS; i++) backend.set(`${SPEED}#activity:record-${i}`, null);
    const p = page(backend, 'a');
    await assert.rejects(p.register.write(SPEED, 1.5), { code: 'ACTIVITY_REGISTER_FULL' });
    assert.equal(backend.get(SPEED), 1);
    assert.equal(p.calls.some(([method]) => method === 'remove'), false);
    await p.register.set(SPEED, 2);
    assert.equal(fresh(backend).read(SPEED), 2);
  }
});
