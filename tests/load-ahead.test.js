// Load more posts ahead, against the end of Home's feed as it was live on 2026-11-04: an empty
// div with no attributes below the last post inside role=main, watched by an IntersectionObserver
// with a bottom-only margin, and Facebook's gray loading cards after it. The observers here are
// stand-ins that record what they're asked, since happy-dom draws nothing. Whether Facebook
// fetches further ahead with it was checked live (see the notes in load-ahead.js).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import loadAhead, { bottomMargin, createStarter, isFeedEnd, widenFeedEnd } from '../src/features/feed/load-ahead.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const LOADING = '<div aria-label="Loading..." role="status" data-visualcompletion="loading-state"><div class="card"></div></div>';
const HOME = (loading = true) => `<div role="main"><div class="feed">
  <div aria-posinset="1"><a href="/someone">Someone</a><div>A post</div></div>
  <div></div>${loading ? LOADING : ''}
</div></div><div class="elsewhere"><div></div></div>`;

function page(html = HOME()) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const feedEnd = (doc) => doc.querySelector('.feed > div:not([aria-posinset]):not([role])');

// An IntersectionObserver stand-in. Every one made is kept in made, in order.
function observerClass() {
  const made = [];
  class Observer {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.watched = [];
      this.dropped = [];
      this.cut = false;
      made.push(this);
    }

    observe(target) {
      this.watched.push(target);
    }

    unobserve(target) {
      this.dropped.push(target);
    }

    disconnect() {
      this.cut = true;
    }

    takeRecords() {
      return this.watched.map((target) => ({ target, own: this }));
    }
  }
  return { Observer, made };
}

test('only a large margin on the bottom alone reads as the feed end\'s margin', () => {
  assert.equal(bottomMargin('0px 0px 2570px 0px'), 2570);
  assert.equal(bottomMargin(' 0px 0px 7710px 0px '), 7710);
  assert.equal(bottomMargin('0 0 5140.5px 0'), 5140.5);
  for (const other of ['0px 0px 500px 0px', '0px 0px 0px 0px', '600px 0px', '4000px 0px 4000px 0px', '-56px 0px 0px 0px', '0px 0px 50% 0px', '', undefined, null, 2570]) {
    assert.equal(bottomMargin(other), null, String(other));
  }
});

test('the feed end is the empty div with no attributes inside role=main', () => {
  const doc = page().document;
  assert.ok(isFeedEnd(feedEnd(doc)), 'the div below the last post');
  assert.ok(!isFeedEnd(doc.querySelector('.elsewhere > div')), 'an empty div outside role=main');
  assert.ok(!isFeedEnd(doc.querySelector('[role="status"]')), 'the loading card');
  assert.ok(!isFeedEnd(doc.querySelector('.card')), 'an empty div with a class');
  assert.ok(!isFeedEnd(doc.querySelector('[aria-posinset]')), 'a post');
  assert.ok(!isFeedEnd(null) && !isFeedEnd(doc.createTextNode('')), 'not an element');
});

test("the feed's end is watched further ahead, and Facebook's callback still sees its own observer", () => {
  const doc = page().document;
  const { Observer, made } = observerClass();
  const win = { IntersectionObserver: Observer };
  let widened = 0;
  assert.ok(widenFeedEnd(win, () => 25000, () => widened++));
  const seen = [];
  const facebook = function (entries, observer) {
    seen.push({ entries, self: this, observer });
  };
  const own = new win.IntersectionObserver(facebook, { rootMargin: '0px 0px 2570px 0px', threshold: [0] });
  own.observe(feedEnd(doc));
  assert.equal(made.length, 2, "Facebook's observer and the wider one");
  const wide = made[1];
  assert.equal(wide.options.rootMargin, '0px 0px 25000px 0px');
  assert.deepEqual(wide.options.threshold, [0], "Facebook's other options carry over");
  assert.ok(wide.watched.length === 1 && wide.watched[0] === feedEnd(doc), 'the wider observer watches the feed end');
  assert.equal(made[0].watched.length, 0, "Facebook's own doesn't watch it as well");
  assert.equal(widened, 1);

  const entries = [{ isIntersecting: true }];
  wide.callback(entries);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].entries === entries, 'the entries as they came');
  assert.ok(seen[0].self === own && seen[0].observer === own, "Facebook's callback gets its own observer, both ways");

  // A second target on the same observer reuses the wider one.
  doc.querySelector('.feed').append(doc.createElement('div'));
  own.observe(doc.querySelector('.feed').lastElementChild);
  assert.equal(made.length, 2);
  assert.equal(wide.watched.length, 2);
  assert.equal(widened, 1);
});

test("everything else stays on Facebook's observer as it was", () => {
  const doc = page().document;
  const { Observer, made } = observerClass();
  let reach = 25000;
  const win = { IntersectionObserver: Observer };
  widenFeedEnd(win, () => reach);

  const own = new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' });
  own.observe(doc.querySelector('.elsewhere > div'));
  own.observe(doc.querySelector('[role="status"]'));
  assert.equal(made.length, 1, 'no wider observer for targets that are not the feed end');
  assert.equal(made[0].watched.length, 2);

  reach = 0;
  own.observe(feedEnd(doc));
  reach = 2000;
  own.observe(feedEnd(doc));
  assert.equal(made.length, 1, 'switched off, off Home, or no further than Facebook already looks');
  assert.equal(made[0].watched.length, 4);

  reach = 25000;
  for (const options of [undefined, {}, { rootMargin: '600px 0px' }, { rootMargin: '0px 0px 0px 0px' }]) {
    const other = new win.IntersectionObserver(() => {}, options);
    assert.ok(!Object.hasOwn(other, 'observe'), `${JSON.stringify(options)}: left untouched`);
    other.observe(feedEnd(doc));
  }
  assert.equal(made.length, 5, 'no wider observer for any of them');
});

test('unobserve, disconnect and takeRecords reach the wider observer too', () => {
  const doc = page().document;
  const { Observer, made } = observerClass();
  const win = { IntersectionObserver: Observer };
  widenFeedEnd(win, () => 25000);
  const own = new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' });
  const card = doc.querySelector('[role="status"]');
  own.observe(feedEnd(doc));
  own.observe(card);
  const [facebook, wide] = made;

  const records = own.takeRecords();
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.own === wide && record.target === feedEnd(doc)), "the wider observer's records");
  assert.ok(records.some((record) => record.own === facebook && record.target === card), "Facebook's own records");

  own.unobserve(feedEnd(doc));
  own.unobserve(card);
  assert.ok(wide.dropped.length === 1 && wide.dropped[0] === feedEnd(doc), 'the feed end let go from the wider observer');
  assert.ok(facebook.dropped.length === 1 && facebook.dropped[0] === card, "the card from Facebook's");

  own.observe(feedEnd(doc));
  own.disconnect();
  assert.ok(wide.cut && facebook.cut, 'both disconnected');
  own.unobserve(feedEnd(doc));
  assert.equal(wide.dropped.length, 1, 'after a disconnect the feed end belongs to neither');
});

test('a feed end watched again stays with the observer that has it, however the switch changed', () => {
  const doc = page().document;
  const { Observer, made } = observerClass();
  let reach = 25000;
  const win = { IntersectionObserver: Observer };
  widenFeedEnd(win, () => reach);
  const own = new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' });
  own.observe(feedEnd(doc));
  const [facebook, wide] = made;
  reach = 0;
  own.observe(feedEnd(doc));
  assert.equal(facebook.watched.length, 0, "switched off since, and still not on Facebook's as well");
  own.unobserve(feedEnd(doc));
  assert.ok(wide.dropped.length === 1 && facebook.dropped.length === 0, 'let go from the one that has it');

  const later = new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' });
  later.observe(feedEnd(doc));
  reach = 25000;
  later.observe(feedEnd(doc));
  assert.equal(made.length, 3, 'switched on since, and no wider observer to watch it twice');
  later.unobserve(feedEnd(doc));
  assert.equal(made[2].dropped.length, 1);
});

test('the stand-in builds the same observers', () => {
  const { Observer } = observerClass();
  const win = { IntersectionObserver: Observer };
  widenFeedEnd(win, () => 25000);
  assert.ok(win.IntersectionObserver !== Observer, 'replaced');
  assert.ok(win.IntersectionObserver.prototype === Observer.prototype);
  assert.ok(new win.IntersectionObserver(() => {}) instanceof Observer);
  assert.ok(new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' }) instanceof win.IntersectionObserver);
  class Mine extends win.IntersectionObserver {}
  assert.ok(new Mine(() => {}) instanceof Mine, 'a subclass still gets its own prototype');
  assert.equal(widenFeedEnd({}, () => 0), false, 'nothing to wrap');
});

// A window that scrolls when asked, and runs timers when told to.
function scroller({ y = 0, room = true } = {}) {
  const timers = [];
  return {
    scrollX: 0,
    scrollY: y,
    moves: [],
    scrollTo({ top, behavior }) {
      this.moves.push(`${top} ${behavior}`);
      if (room) this.scrollY = top;
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
    },
    runTimers() {
      for (const { fn } of timers.splice(0)) fn();
    },
    timers,
  };
}

test('arriving at the top of Home, the page goes down 1 px and back once the feed is drawn', () => {
  const win = page(HOME(false));
  const doc = win.document;
  const view = scroller();
  let live = true;
  const starter = createStarter({ win: view, doc, live: () => live });

  starter.check();
  assert.equal(view.moves.length, 0, 'not before the loading cards are drawn');
  doc.querySelector('.feed').insertAdjacentHTML('beforeend', LOADING);

  Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
  starter.check();
  assert.equal(view.moves.length, 0, 'not in a tab nobody can see');
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false });

  live = false;
  starter.check();
  assert.equal(view.moves.length, 0, 'not switched off or off Home');
  live = true;

  starter.check();
  assert.deepEqual(view.moves, ['1 instant']);
  assert.equal(view.timers[0].ms, 150, 'back after Facebook has seen the scroll');
  view.runTimers();
  assert.deepEqual(view.moves, ['1 instant', '0 instant']);
  assert.equal(starter.starts(), 1);

  starter.check();
  assert.equal(view.moves.length, 2, 'once a visit');
  starter.reset();
  starter.check();
  assert.equal(view.moves.length, 3, 'and again on the next visit');
});

test("the page isn't moved when it's already scrolled, or put back once you've scrolled on", () => {
  const doc = page().document;
  const scrolled = scroller({ y: 400 });
  const starter = createStarter({ win: scrolled, doc, live: () => true });
  starter.check();
  scrolled.scrollY = 0;
  starter.check();
  assert.equal(scrolled.moves.length, 0, 'a page that was scrolled has started fetching');

  const moving = scroller();
  createStarter({ win: moving, doc, live: () => true }).check();
  moving.scrollY = 300;
  moving.runTimers();
  assert.deepEqual(moving.moves, ['1 instant'], 'you scrolled on before it went back');
});

test("a page too short to scroll is tried again as it's drawn", () => {
  const doc = page().document;
  const view = scroller({ room: false });
  const starter = createStarter({ win: view, doc, live: () => true });
  starter.check();
  assert.equal(starter.starts(), 0);
  assert.equal(view.timers.length, 0, 'nothing to put back');
  starter.check();
  assert.equal(view.moves.length, 2, 'tried again');
});

test('setup widens the feed end only while switched on and on Home, by the screens picked', async () => {
  const win = page();
  const doc = win.document;
  const { Observer, made } = observerClass();
  win.IntersectionObserver = Observer;
  let on = true;
  let type = 'home';
  let screens = '25';
  const rows = new Map();
  loadAhead.setup({
    win, doc,
    router: { current: () => ({ type }), subscribe: () => {} },
    settings: { subscribe: () => {} },
    diagnostics: { add: (label, read) => rows.set(label, read) },
    enabled: () => on,
    option: (key) => (key === 'screens' ? screens : undefined),
  });
  const watch = () => {
    const before = made.length;
    new win.IntersectionObserver(() => {}, { rootMargin: '0px 0px 2570px 0px' }).observe(feedEnd(doc));
    return made.slice(before).map((observer) => observer.options?.rootMargin);
  };
  assert.deepEqual(watch(), ['0px 0px 2570px 0px', `0px 0px ${25 * win.innerHeight}px 0px`]);
  screens = '50';
  assert.deepEqual(watch(), ['0px 0px 2570px 0px', `0px 0px ${50 * win.innerHeight}px 0px`]);
  screens = 'lots';
  assert.deepEqual(watch(), ['0px 0px 2570px 0px', `0px 0px ${25 * win.innerHeight}px 0px`], 'an unknown choice reads as the default');
  on = false;
  assert.deepEqual(watch(), ['0px 0px 2570px 0px']);
  on = true;
  type = 'group';
  assert.deepEqual(watch(), ['0px 0px 2570px 0px']);
  assert.equal(rows.get('Home loading ahead')(), '3 pages watched further ahead, started early 0 times');
  on = false;
  assert.equal(rows.get('Home loading ahead')(), 'off');
});

test('the switch is on the Feed page, off to start, with its choices', () => {
  assert.equal(loadAhead.section, 'feed');
  assert.equal(loadAhead.default, false);
  assert.equal(loadAhead.needsPage, true, "it changes Facebook's own observers, so it needs the page");
  assert.deepEqual(loadAhead.options.map(({ key, default: value }) => [key, value]), [['screens', '25']]);
  assert.deepEqual(loadAhead.options[0].choices.map(({ value, label }) => [value, label]), [['10', '10 screens'], ['25', '25 screens'], ['50', '50 screens']]);
});
