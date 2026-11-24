import { test } from 'node:test';
import assert from 'node:assert/strict';
import freezeLastActive, { ACTIVE, CLIENT, IDLE, SINGLETON, holdPresence } from '../src/features/chats/freeze-last-active.js';

const OFFLINE = 3;

// Facebook's presence client the way the served code builds it (2026-11-24): a report is kept
// as the last state and, while the stream is open, goes out as an amendment in JSON. The stream
// opening sends the last state again. Statuses that come in fill a map, and the people to ask
// about go out as an amendment of their own.
function presenceModule() {
  class PresenceUnifiedClient {
    constructor() {
      this.last = IDLE;
      this.stream = null;
      this.map = new Map();
      this.sent = [];
    }

    async amend(amendment) {
      if (this.stream == null) return false;
      return this.stream.amendWithAck(JSON.stringify({ payload: { ...amendment } }));
    }

    reportUserPresence(availability) {
      this.last = availability;
      if (this.stream == null) return Promise.resolve(false);
      return this.amend({ presenceReportingAmendment: { reportingArguments: { availability, foregrounded: availability === ACTIVE, mutationId: 'id' } } });
    }

    addAdditionalContacts(ids) {
      return this.amend({ additionalContacts: { additionalContacts: ids } });
    }

    startStream() {
      this.stream = {
        amendWithAck: async (text) => {
          this.sent.push(JSON.parse(text).payload);
          return true;
        },
      };
      return this.reportUserPresence(this.last);
    }

    onData(text) {
      for (const update of JSON.parse(text).presenceUpdates) this.map.set(update.userId, update);
    }
  }
  return { PresenceUnifiedClient };
}

const reports = (client) => client.sent.filter((one) => one.presenceReportingAmendment).map((one) => one.presenceReportingAmendment.reportingArguments).map((args) => [args.availability, args.foregrounded]);

function held({ on = true } = {}) {
  const exports = presenceModule();
  const state = { on, held: 0, errors: [] };
  const hold = holdPresence(exports, { enabled: () => state.on, onHeld: () => state.held++, onError: (error) => state.errors.push(error) });
  const client = new exports.PresenceUnifiedClient();
  return { exports, state, hold, client };
}

test('an active report goes out as idle while the switch is on, and as Facebook wrote it while off', async () => {
  const { state, client } = held();
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  await client.reportUserPresence(IDLE);
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client), [[IDLE, false], [IDLE, false], [IDLE, false], [IDLE, false]]);
  assert.equal(state.held, 2, 'only the active reports count as held');
  state.on = false;
  await client.reportUserPresence(ACTIVE);
  await client.reportUserPresence(IDLE);
  assert.deepEqual(reports(client).slice(4), [[ACTIVE, true], [IDLE, false]]);
  assert.equal(state.held, 2);
});

test("without the switch, Facebook's client reports active as it always did", async () => {
  const client = new (presenceModule().PresenceUnifiedClient)();
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client), [[IDLE, false], [ACTIVE, true]]);
});

test('idle and offline reports are never touched', async () => {
  const { state, client } = held();
  await client.startStream();
  await client.reportUserPresence(OFFLINE);
  await client.reportUserPresence(IDLE);
  assert.deepEqual(reports(client), [[IDLE, false], [OFFLINE, false], [IDLE, false]]);
  assert.equal(state.held, 0);
});

test("a stream that opens after you were active sends idle, since that's the last thing reported", async () => {
  const { client } = held();
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(client.sent, [], 'nothing leaves while the stream is closed');
  await client.startStream();
  assert.deepEqual(reports(client), [[IDLE, false]]);
});

test("other people's statuses still come in, and the people asked about still go out", async () => {
  const { client } = held();
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  await client.addAdditionalContacts(['100', '200']);
  client.onData(JSON.stringify({ publishType: 1, presenceUpdates: [{ userId: '100', presenceStatus: 1 }, { userId: '200', presenceStatus: 2 }] }));
  assert.deepEqual([...client.map.keys()], ['100', '200']);
  assert.deepEqual(client.sent.at(-1), { additionalContacts: { additionalContacts: ['100', '200'] } });
});

test('turning the switch on says idle right away, and turning it off says active only on the page in use', async () => {
  const { state, hold, client } = held({ on: false });
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client), [[IDLE, false], [ACTIVE, true]]);
  state.on = true;
  assert.equal(hold.sync(true), 1);
  await Promise.resolve();
  assert.deepEqual(reports(client).at(-1), [IDLE, false]);
  state.on = false;
  assert.equal(hold.sync(false), 0, 'a tab in the background stays as it is');
  assert.equal(reports(client).length, 3);
  assert.equal(hold.sync(true), 1);
  await Promise.resolve();
  assert.deepEqual(reports(client).at(-1), [ACTIVE, true]);
});

test('the client is wrapped once however often it is handed over, and a changed client is left alone', () => {
  const exports = presenceModule();
  const first = holdPresence(exports, { enabled: () => true });
  const wrapped = exports.PresenceUnifiedClient.prototype.reportUserPresence;
  assert.equal(holdPresence(exports, { enabled: () => true }), first);
  assert.equal(exports.PresenceUnifiedClient.prototype.reportUserPresence, wrapped);
  assert.equal(holdPresence({ PresenceUnifiedClient: class {} }, { enabled: () => true }), null);
  assert.equal(holdPresence({}, { enabled: () => true }), null);
});

test("a report of the script's own that fails is noted and doesn't stop the page", async () => {
  const { state, hold, client } = held();
  await client.startStream();
  client.stream.amendWithAck = () => Promise.reject(new Error('stream gone'));
  hold.add(client);
  hold.sync(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].message, 'stream gone');
});

// Facebook's loader, as much of it as the switch meets: __d defines a module, its factory runs
// the first time something asks for it, and requireLazy calls back once the modules it names are
// defined, running them on the spot.
function page({ readyState = 'loading' } = {}) {
  const factories = new Map();
  const results = new Map();
  const asked = [];
  let waiting = [];
  const listeners = new Map();
  const listen = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const doc = { readyState, visibilityState: 'visible', focused: true, hasFocus: () => doc.focused, addEventListener: listen };
  const win = { document: doc, addEventListener: listen };
  const require = (name) => {
    if (!results.has(name)) {
      const module = { exports: {} };
      factories.get(name)(win, require, require, require, requireLazy, module, module.exports);
      results.set(name, module.exports);
    }
    return results.get(name);
  };
  function requireLazy(names, callback) {
    asked.push(...names);
    const run = () => {
      if (!names.every((name) => factories.has(name))) return false;
      callback(...names.map(require));
      return true;
    };
    if (!run()) waiting.push(run);
  }
  const definer = function (name, deps, factory) {
    factories.set(name, factory);
    waiting = waiting.filter((run) => !run());
  };
  win.__d = definer;
  win.requireLazy = requireLazy;
  return {
    win,
    doc,
    asked,
    definer,
    require,
    // The bundle with Facebook's presence code arrives.
    bundle() {
      win.__d(CLIENT, [], (t, n, r, o, a, i, l) => {
        l.PresenceUnifiedClient = presenceModule().PresenceUnifiedClient;
      }, 98);
      win.__d(SINGLETON, [CLIENT], (t, n, r, o, a, i, l) => {
        l.FBPresenceUnifiedClientSingleton = new (n(CLIENT).PresenceUnifiedClient)();
      }, 98);
    },
    loaded() {
      doc.readyState = 'complete';
      for (const fn of listeners.get('load') ?? []) fn();
    },
  };
}

function start({ on = true, ...options } = {}) {
  const fb = page(options);
  const switchState = { on };
  const listeners = [];
  const rows = new Map();
  const notes = [];
  let unavailable = 0;
  freezeLastActive.setup({
    win: fb.win,
    doc: fb.doc,
    settings: { subscribe: (fn) => listeners.push(fn) },
    enabled: () => switchState.on,
    diagnostics: { add: (name, read) => rows.set(name, read), changed() {} },
    log: { warn: (message) => notes.push(message), error: (message) => notes.push(message) },
    markUnavailable: () => unavailable++,
  });
  return {
    fb,
    notes,
    unavailable: () => unavailable,
    row: () => rows.get('Active reports sent as idle')(),
    turn(value) {
      switchState.on = value;
      for (const fn of listeners) fn();
    },
  };
}

test("Facebook's modules are left alone until the switch is first turned on", () => {
  const run = start({ on: false });
  run.fb.bundle();
  run.fb.loaded();
  assert.equal(run.fb.win.__d, run.fb.definer, "Facebook's module definer isn't wrapped");
  assert.deepEqual(run.fb.asked, []);
  assert.equal(run.row(), 'switch off');
});

test('with the switch on from the start, the first thing the page reports is idle', async () => {
  const run = start();
  assert.deepEqual(run.fb.asked, [], 'nothing is asked of a page that is still loading');
  assert.equal(run.row(), "Facebook's presence code isn't loaded yet");
  run.fb.bundle();
  const client = run.fb.require(SINGLETON).FBPresenceUnifiedClientSingleton;
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client), [[IDLE, false], [IDLE, false]]);
  assert.equal(run.row(), '1');
  run.fb.loaded();
  assert.equal(run.unavailable(), 0);
});

test('turned on after the page already said active, the client is told idle at once', async () => {
  const run = start({ on: false, readyState: 'complete' });
  run.fb.bundle();
  const client = run.fb.require(SINGLETON).FBPresenceUnifiedClientSingleton;
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client).at(-1), [ACTIVE, true]);
  run.turn(true);
  await Promise.resolve();
  assert.deepEqual(reports(client).slice(2), [[IDLE, false]], 'one idle report, not two');
  await client.reportUserPresence(ACTIVE);
  assert.deepEqual(reports(client).at(-1), [IDLE, false]);
  run.turn(false);
  await Promise.resolve();
  assert.deepEqual(reports(client).at(-1), [ACTIVE, true], 'off again on the page in use, Facebook hears active');
});

test('turned off in a tab that is in the background, nothing is sent', async () => {
  const run = start({ readyState: 'complete' });
  run.fb.bundle();
  const client = run.fb.require(SINGLETON).FBPresenceUnifiedClientSingleton;
  await client.startStream();
  run.fb.doc.focused = false;
  const before = client.sent.length;
  run.turn(false);
  await Promise.resolve();
  assert.equal(client.sent.length, before);
});

test("settings that arrive after Facebook's code did still take hold once the page has loaded", async () => {
  const run = start({ on: false });
  run.fb.bundle();
  const client = run.fb.require(SINGLETON).FBPresenceUnifiedClientSingleton;
  await client.startStream();
  await client.reportUserPresence(ACTIVE);
  run.turn(true);
  assert.equal(run.row(), "Facebook's presence code isn't loaded yet");
  run.fb.loaded();
  await Promise.resolve();
  assert.deepEqual(reports(client).at(-1), [IDLE, false]);
  assert.equal(run.row(), '0');
});

test("when Facebook's client has changed, the switch says so and the page is left as it was", () => {
  const run = start({ readyState: 'complete' });
  run.fb.win.__d(CLIENT, [], (t, n, r, o, a, i, l) => {
    l.PresenceUnifiedClient = class {
      report() {}
    };
  }, 98);
  assert.equal(run.row(), "not held, Facebook's code has changed");
  assert.equal(run.unavailable(), 1);
  assert.equal(run.notes.length, 1);
});
