import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettings } from '../src/core/settings.js';
import { GAME_ADS_KEY, executionTarget, mirrorGameSetting, startGameFrame } from '../src/features/games/frame.js';
import blockAds from '../src/features/games/block-ads.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    kind: 'gm', writes: [],
    get: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    set(key, value) { values.set(key, structuredClone(value)); this.writes.push([key, value]); },
    onChange(key, listener) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
      return () => listeners.get(key).delete(listener);
    },
    remote(key, value) { values.set(key, value); for (const listener of listeners.get(key) ?? []) listener(value); },
  };
}

function frame(url = 'https://game.apps.fbsbx.com/', top = true) {
  const timers = new Map();
  let calls = 0;
  const win = {
    location: new URL(url), Promise, Object,
    setInterval(fn) { timers.set(1, fn); return 1; },
    clearInterval(id) { timers.delete(id); },
    FBInstant: { getInterstitialAdAsync() { calls++; return Promise.resolve('native'); } },
  };
  win.top = top ? win : {};
  return { win, timers, calls: () => calls };
}

const preferences = (saved, account) => createSettings({ storage: saved, features: [blockAds], account, migrations: [] });

test('only top-level matched Facebook pages boot the main app', () => {
  for (const host of ['www.facebook.com', 'web.facebook.com']) {
    assert.equal(executionTarget(frame(`https://${host}/`, true).win), 'facebook');
    assert.equal(executionTarget(frame(`https://${host}/`, false).win), 'skip');
  }
  for (const url of ['https://facebook.com/', 'https://www.facebook.com.attacker.test/', 'http://www.facebook.com/', 'https://example.com/', 'about:blank']) {
    assert.equal(executionTarget(frame(url).win), 'skip', url);
  }
});

test('only HTTPS game hosts select the game branch, at either frame depth', () => {
  for (const host of ['apps.fbsbx.com', 'game.apps.fbsbx.com', 'a.b.apps.fbsbx.com']) {
    for (const top of [true, false]) assert.equal(executionTarget(frame(`https://${host}/`, top).win), 'game');
  }
  for (const url of ['http://game.apps.fbsbx.com/', 'https://apps.fbsbx.com.attacker.test/', 'https://notapps.fbsbx.com/', 'https://fbsbx.com/']) {
    assert.equal(executionTarget(frame(url).win), 'skip', url);
  }
});

test('the shared setting is a boolean and follows opt-in, pause, reset and restore', () => {
  const saved = storage();
  const settings = preferences(saved, '1');
  const bridge = mirrorGameSetting({ storage: saved, settings, enabled: () => settings.enabled(blockAds.id) });
  assert.equal(saved.get(GAME_ADS_KEY), false);
  settings.set(blockAds.id, true);
  assert.equal(saved.get(GAME_ADS_KEY), true);
  settings.set('paused', true);
  assert.equal(saved.get(GAME_ADS_KEY), false);
  settings.set('paused', false);
  assert.equal(saved.get(GAME_ADS_KEY), true);
  const snapshot = settings.reset();
  assert.equal(saved.get(GAME_ADS_KEY), false);
  settings.restore(snapshot);
  assert.equal(saved.get(GAME_ADS_KEY), true);
  assert.ok(saved.writes.filter(([key]) => key === GAME_ADS_KEY).every(([, value]) => typeof value === 'boolean'));
  const count = saved.writes.length;
  settings.set('ui.launcher', false);
  assert.equal(saved.writes.length, count + 1, 'an unrelated setting does not republish game state');
  bridge.stop();
  settings.set(blockAds.id, false);
  assert.equal(saved.get(GAME_ADS_KEY), true, 'closing the publisher leaves the last shared setting');
});

test('the last account changing the switch wins even when its value did not change', () => {
  const saved = storage();
  const a = preferences(saved, '1');
  const b = preferences(saved, '2');
  const bridges = [a, b].map(settings => mirrorGameSetting({ storage: saved, settings, enabled: () => settings.enabled(blockAds.id) }));
  b.set(blockAds.id, true);
  assert.equal(saved.get(GAME_ADS_KEY), true);
  a.set(blockAds.id, false);
  assert.equal(saved.get(GAME_ADS_KEY), false);
  for (const bridge of bridges) bridge.stop();
});

test('a failed shared save is logged and can be retried', () => {
  const saved = storage();
  const settings = preferences(saved, '1');
  const write = saved.set.bind(saved);
  const errors = [];
  saved.set = () => { throw new Error('storage unavailable'); };
  const bridge = mirrorGameSetting({ storage: saved, settings, enabled: () => true, log: { error: (...args) => errors.push(args) } });
  assert.equal(saved.get(GAME_ADS_KEY, false), false);
  assert.equal(errors.length, 1);
  saved.set = write;
  bridge.sync();
  assert.equal(saved.get(GAME_ADS_KEY), true);
  bridge.stop();
});

test('page storage cannot publish or enable game hooks', async () => {
  const saved = { kind: 'localStorage', set() { throw new Error('must not write'); } };
  const { win } = frame();
  const original = win.FBInstant.getInterstitialAdAsync;
  assert.equal(mirrorGameSetting({ storage: saved }), null);
  assert.equal(startGameFrame({ win, storage: saved }), null);
  assert.equal(win.FBInstant.getInterstitialAdAsync, original);
  let unavailable = false;
  blockAds.setup({ storage: saved, markUnavailable: () => { unavailable = true; } });
  assert.equal(unavailable, true);
  assert.equal(await original(), 'native');
});

test('game frames start off and follow remote changes without reading Facebook cookies', async () => {
  const saved = storage();
  const { win, calls, timers } = frame();
  Object.defineProperty(win, 'document', { get() { throw new Error('must not read the game document or cookies'); } });
  const controller = startGameFrame({ win, storage: saved });
  try {
    assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
    saved.remote(GAME_ADS_KEY, true);
    await assert.rejects(win.FBInstant.getInterstitialAdAsync(), { code: 'ADS_NO_FILL' });
    assert.equal(calls(), 1);
    saved.remote(GAME_ADS_KEY, false);
    assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
  } finally { controller.stop(); }
  assert.equal(timers.size, 0);
  saved.remote(GAME_ADS_KEY, true);
  assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
});

test('invalid or unreadable shared values leave ads under SDK control', async () => {
  for (const value of ['true', 1, {}, null, undefined]) {
    const { win } = frame();
    const controller = startGameFrame({ win, storage: storage({ [GAME_ADS_KEY]: value }) });
    assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
    controller.stop();
  }
  const saved = storage();
  saved.get = () => { throw new Error('read failed'); };
  const errors = [];
  const { win } = frame();
  const controller = startGameFrame({ win, storage: saved, log: { error: (...args) => errors.push(args) } });
  assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
  assert.equal(errors.length, 1);
  controller.stop();
});

test('duplicate game injections share one controller and can restart after cleanup', () => {
  const saved = storage({ [GAME_ADS_KEY]: true });
  const { win, timers } = frame();
  const first = startGameFrame({ win, storage: saved });
  assert.equal(startGameFrame({ win, storage: saved }), first);
  assert.equal(timers.size, 1);
  first.stop();
  first.stop();
  const second = startGameFrame({ win, storage: saved });
  assert.notEqual(second, first);
  second.stop();
  assert.equal(timers.size, 0);
});

test('a failed storage subscription leaves the game in control and still allows cleanup', async () => {
  const saved = storage({ [GAME_ADS_KEY]: true });
  saved.onChange = () => { throw new Error('listener failed'); };
  const errors = [];
  const { win, timers } = frame();
  const controller = startGameFrame({ win, storage: saved, log: { error: (...args) => errors.push(args) } });
  assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
  assert.equal(errors.length, 1);
  controller.stop();
  assert.equal(timers.size, 0);
});

test('a failed storage unsubscribe cannot leave the SDK hook running after stop', async () => {
  const saved = storage({ [GAME_ADS_KEY]: true });
  saved.onChange = () => () => { throw new Error('unsubscribe failed'); };
  const { win, timers } = frame();
  const errors = [];
  const controller = startGameFrame({ win, storage: saved, log: { error: (...args) => errors.push(args) } });
  await assert.rejects(win.FBInstant.getInterstitialAdAsync(), { code: 'ADS_NO_FILL' });
  controller.stop();
  assert.equal(errors.length, 1);
  assert.equal(timers.size, 0);
  assert.equal(await win.FBInstant.getInterstitialAdAsync(), 'native');
});
