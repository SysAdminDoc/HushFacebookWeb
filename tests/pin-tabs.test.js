import { test } from 'node:test';
import assert from 'node:assert/strict';
import pinTabs, { FACTORY, LIST_ARGS, OURS, USER, barHydrated, pinEdges } from '../src/features/appearance/pin-tabs.js';
import { tabsCss } from '../src/features/appearance/hide-tabs.js';

const HOME = '4748854339';
const FRIENDS = '2356318349';
const VIDEO = '2392950137';
const MARKETPLACE = '1606854132932955';
const GROUPS = '2361831622';
const GAMING = '513746992167374';
const EVENTS = '2344061033';
const ROW = 'Tabs added by Pin tabs';

// Relay's store as an updater sees it (2026-11-25): records by id, each field kept under its
// name and arguments, links held as references to other records.
function relayStore() {
  const records = new Map();
  const key = (name, args) => (args ? `${name}(${Object.keys(args).sort().map((k) => `${k}:${JSON.stringify(args[k])}`).join(',')})` : name);
  const store = { records, writes: 0 };
  const proxy = (id) => {
    const record = records.get(id);
    if (!record) return undefined;
    return {
      getDataID: () => id,
      getType: () => record.__typename,
      getValue: (name, args) => record[key(name, args)],
      setValue(value, name, args) {
        record[key(name, args)] = value;
        return this;
      },
      getLinkedRecord: (name, args) => {
        const ref = record[key(name, args)];
        return ref == null ? ref : proxy(ref.__ref);
      },
      getLinkedRecords: (name, args) => {
        const refs = record[key(name, args)];
        return refs == null ? refs : refs.map((ref) => (ref == null ? ref : proxy(ref.__ref)));
      },
      setLinkedRecord(linked, name, args) {
        record[key(name, args)] = { __ref: linked.getDataID() };
        return this;
      },
      setLinkedRecords(linked, name, args) {
        if (name === 'edges') store.writes++;
        record[key(name, args)] = linked.map((one) => (one == null ? null : { __ref: one.getDataID() }));
        return this;
      },
    };
  };
  store.get = proxy;
  store.create = (id, type) => {
    if (records.has(id)) throw new Error(`${id} is already in the store`);
    records.set(id, { __id: id, __typename: type });
    return proxy(id);
  };
  store.getRoot = () => proxy('client:root');
  return store;
}

// The tab list the way a query result writes it: fresh edge and bookmark records each time.
let sent = 0;
function sendTabs(store, bar) {
  const viewer = store.getRoot().getLinkedRecord('viewer');
  const listId = 'client:viewer:tab_bookmarks';
  const list = store.get(listId) ?? store.create(listId, 'TabBookmarksConnection');
  viewer.setLinkedRecord(list, 'tab_bookmarks', LIST_ARGS);
  const run = ++sent;
  list.setLinkedRecords(bar.map((app, at) => {
    const target = store.get(app) ?? store.create(app, 'Application');
    target.setValue(app, 'id');
    const node = store.create(`bookmark:${run}:${app}`, 'Bookmark');
    node.setValue(`bookmark:${run}:${app}`, 'id');
    node.setValue(0, 'unread_count', { bookmark_render_location: 'COMET_TOP_TAB' });
    node.setValue(1764000000, 'last_used_timestamp');
    node.setLinkedRecord(target, 'bookmarked_node');
    const edge = store.create(`client:viewer:tab_bookmarks:edges:${run}:${at}`, 'ViewerTabBookmarksEdge');
    edge.setLinkedRecord(node, 'node');
    return edge;
  }), 'edges');
}

function facebookStore(bar, { list = true } = {}) {
  const store = relayStore();
  const root = store.create('client:root', '__Root');
  root.setLinkedRecord(store.create('client:root:viewer', 'Viewer'), 'viewer');
  if (list) sendTabs(store, bar);
  return store;
}

const edgesOf = (store) => store.getRoot().getLinkedRecord('viewer').getLinkedRecord('tab_bookmarks', LIST_ARGS).getLinkedRecords('edges');
const tabs = (store) => edgesOf(store).map((edge) => edge.getLinkedRecord('node').getLinkedRecord('bookmarked_node').getValue('id'));
const ids = (store) => edgesOf(store).map((edge) => edge.getDataID());
const mine = (store) => ids(store).filter((id) => id.startsWith(OURS)).length;

test('a picked tab Facebook left out goes in where Facebook puts it, and its own tabs keep their order', () => {
  const store = facebookStore([HOME, FRIENDS, GROUPS]);
  const before = ids(store);
  const result = pinEdges(store, [GAMING, MARKETPLACE]);
  assert.deepEqual(tabs(store), [HOME, FRIENDS, MARKETPLACE, GROUPS, GAMING]);
  assert.deepEqual(result, { pinned: [MARKETPLACE, GAMING], changed: true });
  assert.deepEqual(ids(store).filter((id) => !id.startsWith(OURS)), before);
});

test('tabs the script has no choice for stay where Facebook put them', () => {
  const store = facebookStore([HOME, EVENTS, FRIENDS]);
  pinEdges(store, [GROUPS, VIDEO]);
  assert.deepEqual(tabs(store), [HOME, EVENTS, FRIENDS, VIDEO, GROUPS]);
});

test('an added tab is drawn from the same records as one Facebook sends', () => {
  const store = facebookStore([HOME, FRIENDS]);
  const groups = store.create(GROUPS, 'Application');
  groups.setValue(GROUPS, 'id').setValue('Groups', 'name');
  pinEdges(store, [GROUPS]);
  const edge = edgesOf(store).at(-1);
  const node = edge.getLinkedRecord('node');
  assert.equal(edge.getType(), 'ViewerTabBookmarksEdge');
  assert.equal(node.getType(), 'Bookmark');
  assert.equal(node.getValue('unread_count', { bookmark_render_location: 'COMET_TOP_TAB' }), 0);
  assert.equal(node.getValue('last_used_timestamp'), null);
  assert.equal(node.getLinkedRecord('bookmarked_node').getDataID(), GROUPS);
  assert.equal(node.getLinkedRecord('bookmarked_node').getValue('name'), 'Groups', "the page's own Groups record, not a copy");
});

test('a tab Facebook already sends is never doubled, and a list that needs nothing is not written', () => {
  const store = facebookStore([HOME, FRIENDS, GROUPS]);
  const writes = store.writes;
  assert.deepEqual(pinEdges(store, [GROUPS, FRIENDS]), { pinned: [], changed: false });
  assert.equal(store.writes, writes);
  pinEdges(store, [MARKETPLACE]);
  assert.deepEqual(pinEdges(store, [MARKETPLACE]), { pinned: [MARKETPLACE], changed: false });
  assert.equal(store.writes, writes + 1);
});

test("the script's own tabs come out when they're no longer wanted or Facebook sends them itself", () => {
  const store = facebookStore([HOME, FRIENDS]);
  pinEdges(store, [GROUPS, MARKETPLACE]);
  pinEdges(store, [GROUPS]);
  assert.deepEqual(tabs(store), [HOME, FRIENDS, GROUPS]);
  sendTabs(store, [HOME, FRIENDS, GROUPS]);
  pinEdges(store, [GROUPS]);
  assert.deepEqual(tabs(store), [HOME, FRIENDS, GROUPS]);
  assert.equal(mine(store), 0);
  pinEdges(store, [GAMING]);
  pinEdges(store, []);
  assert.deepEqual(tabs(store), [HOME, FRIENDS, GROUPS]);
  assert.equal(mine(store), 0);
});

test('a store without the tab list is left alone', () => {
  const store = facebookStore([], { list: false });
  const size = store.records.size;
  assert.equal(pinEdges(store, [GROUPS]), null);
  assert.equal(store.records.size, size);
});

test("the bar counts as React's once its tab link carries React's listener keys", () => {
  const link = {};
  const doc = { querySelector: (selector) => (selector === '[role="banner"] li a' ? link : null) };
  assert.equal(barHydrated(doc), false);
  link.__ext = {};
  assert.equal(barHydrated(doc), false, "Meta's own __ext isn't React");
  link['__reactListeners$x1y2'] = {};
  assert.equal(barHydrated(doc), true);
  assert.equal(barHydrated({ querySelector: () => null }), false);
});

test('a tab you pin stays even when Hide tabs would take it off', () => {
  const get = (values) => (key) => values[key];
  const hide = { 'hideTabs.marketplace': true, 'hideTabs.gaming': true };
  assert.match(tabsCss(get(hide)), /marketplace/);
  const pinned = tabsCss(get({ ...hide, pinTabs: true, 'pinTabs.marketplace': true }));
  assert.doesNotMatch(pinned, /marketplace/);
  assert.match(pinned, /gaming/);
  assert.match(tabsCss(get({ ...hide, pinTabs: false, 'pinTabs.marketplace': true })), /marketplace/, 'only while Pin tabs is on');
});

// A page with Facebook's loader, its Relay environment and a top bar React claims when told.
function page({ readyState = 'complete', hydrated = false, bar = [HOME, FRIENDS, GAMING], list = true, factory } = {}) {
  const store = facebookStore(bar, { list });
  const timers = [];
  let now = 0;
  const listeners = new Map();
  const listen = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const link = {};
  const doc = { readyState, addEventListener: listen, querySelector: (selector) => (selector === '[role="banner"] li a' ? link : null) };
  const asked = [];
  const env = { commits: 0, commitUpdate: (updater) => { env.commits++; updater(store); } };
  const modules = { [FACTORY]: factory ?? { getForActorID: (id) => (id === '100' ? env : null) }, [USER]: { getID: () => '100' } };
  const win = {
    document: doc,
    addEventListener: listen,
    setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
    requireLazy: (names, callback) => {
      asked.push(...names);
      callback(...names.map((name) => modules[name]));
    },
  };
  const hydrate = () => {
    link['__reactListeners$abc123'] = {};
  };
  if (hydrated) hydrate();
  return {
    win,
    doc,
    store,
    env,
    asked,
    hydrate,
    parsed() {
      doc.readyState = 'interactive';
      for (const fn of listeners.get('DOMContentLoaded') ?? []) fn();
    },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const next = timers.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

function start({ on = true, picks = { groups: true, friends: true }, ...options } = {}) {
  const fb = page(options);
  const state = { on, picks: { video: false, marketplace: false, gaming: false, groups: false, friends: false, ...picks } };
  const settingsListeners = [];
  const routeListeners = [];
  const rows = new Map();
  const notes = [];
  let unavailable = 0;
  pinTabs.setup({
    win: fb.win,
    doc: fb.doc,
    settings: { subscribe: (fn) => settingsListeners.push(fn) },
    router: { subscribe: (fn) => routeListeners.push(fn) },
    enabled: () => state.on,
    option: (key) => state.picks[key],
    diagnostics: { add: (name, read) => rows.set(name, read), changed() {} },
    log: { warn: (message) => notes.push(message), error: (message) => notes.push(message) },
    markUnavailable: () => unavailable++,
  });
  const changed = () => {
    for (const fn of settingsListeners) fn();
  };
  return {
    fb,
    notes,
    unavailable: () => unavailable,
    row: () => rows.get(ROW)(),
    turn(value) {
      state.on = value;
      changed();
    },
    pick(key, value) {
      state.picks[key] = value;
      changed();
    },
    navigate() {
      for (const fn of routeListeners) fn({ type: 'home' });
    },
  };
}

test("Facebook's modules and tab list are left alone until the switch is first turned on", () => {
  const run = start({ on: false, hydrated: true });
  run.fb.tick(30000);
  run.navigate();
  assert.deepEqual(run.fb.asked, []);
  assert.equal(run.fb.env.commits, 0);
  assert.equal(run.row(), 'switch off');
  run.turn(true);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS, GAMING]);
});

test('nothing is added until React has claimed the bar, so the page it drew still matches', () => {
  const run = start({ readyState: 'loading' });
  assert.deepEqual(run.fb.asked, [], 'nothing is asked of a page still loading');
  run.fb.parsed();
  run.fb.tick(2000);
  assert.equal(run.fb.env.commits, 0);
  assert.equal(run.row(), "waiting for Facebook's top bar");
  run.fb.hydrate();
  run.fb.tick(250);
  assert.equal(run.fb.env.commits, 1);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS, GAMING], 'the reported bar of Friends and Gaming gets Groups back');
  assert.equal(run.row(), 'Groups');
});

test('a bar React never seems to claim still gets its tabs 20 seconds after the page is read', () => {
  const run = start({ readyState: 'loading' });
  run.fb.parsed();
  run.fb.tick(19500);
  assert.equal(run.fb.env.commits, 0);
  run.fb.tick(1000);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS, GAMING]);
});

test("turning a pick or the switch off takes out only the script's tabs", () => {
  const run = start({ hydrated: true, bar: [HOME, FRIENDS], picks: { groups: true, marketplace: true } });
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, MARKETPLACE, GROUPS]);
  assert.equal(run.row(), 'Marketplace, Groups');
  const theirs = ids(run.fb.store).filter((id) => !id.startsWith(OURS));
  run.pick('marketplace', false);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS]);
  run.turn(false);
  assert.deepEqual(ids(run.fb.store), theirs);
  assert.equal(run.row(), 'switch off');
  run.turn(true);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS]);
});

test('a list Facebook sends again without the pins gets them back after a page change', () => {
  const run = start({ hydrated: true, bar: [HOME, FRIENDS] });
  sendTabs(run.fb.store, [HOME, FRIENDS]);
  run.navigate();
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS]);
  sendTabs(run.fb.store, [HOME, FRIENDS]);
  run.fb.tick(1500);
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GROUPS], 'a list that lands a moment after the page changes too');
});

test('when Facebook sends a pinned tab itself the row says nothing was needed', () => {
  const run = start({ hydrated: true, bar: [HOME, FRIENDS] });
  sendTabs(run.fb.store, [HOME, FRIENDS, GROUPS]);
  run.navigate();
  assert.equal(mine(run.fb.store), 0);
  assert.equal(run.row(), 'none needed');
});

test('a page without the tab list is left as it was', () => {
  const run = start({ hydrated: true, list: false });
  assert.equal(run.row(), 'no tab list on this page');
  assert.equal(run.unavailable(), 0);
});

test("when Facebook's code has changed, the switch says so and the list is left alone", () => {
  const run = start({ hydrated: true, factory: {} });
  assert.deepEqual(tabs(run.fb.store), [HOME, FRIENDS, GAMING]);
  assert.equal(run.row(), "not pinned, Facebook's code has changed");
  assert.equal(run.unavailable(), 1);
  assert.equal(run.notes.length, 1);
});
