import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.HFW_BROWSER_OUTPUT
  ? resolve(process.env.HFW_BROWSER_OUTPUT)
  : await mkdtemp(join(tmpdir(), 'hushfacebook-web-browser-'));
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('fixtures/index.js', import.meta.url))],
  absWorkingDir: root, bundle: true, write: false, format: 'iife', globalName: 'hfwBrowserFixture',
  platform: 'browser', target: ['chrome120', 'firefox128'], logLevel: 'silent',
  define: { __HFW_VERSION__: JSON.stringify(version), __HFW_TARGET__: JSON.stringify('userscript') },
});
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local browser regression</title><style>body{margin:0;padding:16px;background:#18191a;color:#edf2f8;font:16px system-ui}section,article,main{padding:12px;border:1px solid #768599}a{color:#8abfff}button{font:inherit}</style></head><body><script src="/fixture.js"></script></body></html>';
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); }
  else if (url.pathname === '/fixture.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
  else if (url.pathname === '/xhr') {
    response.setHeader('content-type', 'text/plain');
    response.write('{"fixture":1}\n');
    setTimeout(() => response.end('{"fixture":2}\n'), 40);
  } else if (url.pathname === '/xhr-split') {
    // One line cut in two, with time for the page to read the first half on its own. Chromium
    // holds back a short first chunk while it sniffs the type, hence the padding.
    response.setHeader('content-type', 'text/plain');
    response.setHeader('x-content-type-options', 'nosniff');
    response.write(`{"keep":1,"pad":"${'x'.repeat(4096)}","ad":`);
    setTimeout(() => response.end('1}\n{"fixture":2}\n'), 250);
  } else if (url.pathname === '/download-picture' || url.pathname === '/download-sound') {
    response.setHeader('content-type', 'application/octet-stream');
    response.write(Buffer.alloc(40, 1));
    setTimeout(() => response.end(Buffer.alloc(40, 2)), 40);
  } else { response.statusCode = 404; response.end('Fixture route not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const scenarios = [
  { id: 'xhr-native', fixture: 'network', wrapper: 'native', order: 'before' },
  ...['subclass', 'proxy', 'getter', 'editor'].flatMap((wrapper) => ['before', 'after'].map((order) => ({ id: `xhr-${wrapper}-${order}`, fixture: 'network', wrapper, order }))),
  { id: 'delayed-bridge', fixture: 'delayedBridge' },
  { id: 'dialog-search-undo', fixture: 'panel' },
  { id: 'staged-share', fixture: 'stagedShare', screenshot: true },
  { id: 'recycled-posts', fixture: 'recycledPosts', screenshot: true },
  { id: 'bounded-download', fixture: 'boundedDownload' },
  { id: 'active-dots', fixture: 'activeDots', screenshot: true },
  { id: 'wider-feed', fixture: 'widerFeed', screenshot: true, viewport: { width: 1600, height: 1000 } },
  { id: 'hidden-note', fixture: 'hiddenNote', screenshot: true },
  { id: 'overview-hidden', fixture: 'overviewHidden', screenshot: true },
  { id: 'general-toolbar', fixture: 'generalToolbar', screenshot: true },
  ...['light', 'dark'].map((theme) => ({ id: `panel-${theme}`, fixture: 'panelTheme', theme, screenshot: true, viewport: { width: 1100, height: 760 } })),
  { id: 'post-dates', fixture: 'postDates', screenshot: true },
  { id: 'stories-gap', fixture: 'storiesGap', viewport: { width: 1000, height: 1000 } },
  { id: 'voice-clip', fixture: 'voiceClip' },
  { id: 'messenger-tap', fixture: 'messengerTap', touch: true },
  { id: 'seller-link', fixture: 'sellerLink', screenshot: true, viewport: { width: 600, height: 400 } },
  { id: 'hide-parts', fixture: 'hideParts', screenshot: true, viewport: { width: 1100, height: 760 } },
];
const DRIVEN = { panel, voiceClip, messengerTap, sellerLink, hideParts };
// HFW_BROWSER_ONLY=id,id runs just those scenarios.
const only = process.env.HFW_BROWSER_ONLY?.split(',').filter(Boolean) ?? [];
const chosen = only.length ? scenarios.filter((scenario) => only.includes(scenario.id)) : scenarios;
assert.ok(chosen.length, `No scenario named ${only.join(', ')}`);
const results = [];
let activeBrowser;
// A fixture's page.evaluate has no timeout of its own, so each scenario gets one. It's per
// scenario because a loaded machine slows every scenario: a 90 second clock on the whole run
// failed Firefox there while each step finished within its own limits.
const SCENARIO_MS = 60000;

async function within(ms, label, work) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} took over ${ms / 1000} seconds`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function panel(page, engine) {
  await page.evaluate(() => window.hfwBrowserFixture.preparePanel());
  await page.keyboard.press('Tab');
  assert.equal((await page.evaluate(() => window.hfwBrowserFixture.panelState())).focusInside, true, 'Native Tab left the modal');
  await page.evaluate(() => window.hfwBrowserFixture.focusPanelControl('search'));
  await page.keyboard.type('privacy');
  await page.waitForFunction(() => window.hfwBrowserFixture.panelState().results > 0);
  await page.evaluate(() => window.hfwBrowserFixture.focusPanelControl('show:quick-setups'));
  await page.keyboard.press('Enter');
  const landed = await page.evaluate(() => window.hfwBrowserFixture.panelState());
  assert.equal(landed.focused, 'quick:privacy', 'Search did not focus its named action');
  assert.equal(landed.query, '');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.hfwBrowserFixture.panelState().undo);
  assert.equal((await page.evaluate(() => window.hfwBrowserFixture.panelState())).watchHistory, true);
  await page.screenshot({ path: join(output, `${engine}-dialog-undo.png`), animations: 'disabled' });
  await page.evaluate(() => window.hfwBrowserFixture.focusPanelControl('reset:undo'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.hfwBrowserFixture.panelState().undo);
  const undone = await page.evaluate(() => window.hfwBrowserFixture.panelState());
  assert.equal(undone.watchHistory, false, 'Undo lost the earlier choice');
  assert.equal(undone.focused, 'quick:privacy', 'Undo lost focus');
  assert.ok(undone.overflow <= 1, 'The settings panel scrolls sideways');
  assert.deepEqual(undone.errors, []);
  await page.evaluate(() => window.hfwBrowserFixture.finishPanel());
  await page.waitForFunction(() => window.hfwBrowserFixture.panelState().openerFocused);
  return { searchFocus: landed.focused, undoFocus: undone.focused, restored: true };
}

// Tap to play with a chat's voice message (#14), clicked and keyed for real.
async function voiceClip(page) {
  const { box } = await page.evaluate(() => window.hfwBrowserFixture.prepareVoiceClip());
  assert.equal(box, 0, 'An <audio> with no controls got a box');
  const settled = async (name) => {
    await page.waitForFunction((key) => !['waiting', undefined].includes(window.hfwBrowserFixture.voiceClipState()[key]), name);
    return (await page.evaluate(() => window.hfwBrowserFixture.voiceClipState()))[name];
  };
  assert.equal(await settled('unprompted'), 'NotAllowedError', 'A sound started with no press');
  await page.click('#clip-text');
  assert.equal(await settled('text'), 'NotAllowedError', 'A click on words started a sound');
  await page.click('#clip-detached');
  assert.equal(await settled('detached'), 'played', 'The play button did not play a sound that is off the page');
  await page.click('#clip-tagged');
  assert.equal(await settled('tagged'), 'played', 'The play button did not play an <audio> with no controls');
  await page.focus('#clip-key');
  await page.keyboard.press('Enter');
  assert.equal(await settled('key'), 'played', 'Enter on the play button did not play');
  await page.click('#clip-elsewhere');
  assert.equal(await settled('video'), 'NotAllowedError', 'A button away from a video started it');
  return page.evaluate(() => window.hfwBrowserFixture.voiceClipState());
}

// Open Messenger as a full page, tapped on a touch screen, clicked and keyed: each goes to the
// Messages page, and none reaches Facebook's own listeners to open the list of chats.
async function messengerTap(page) {
  await page.evaluate(() => window.hfwBrowserFixture.prepareMessenger());
  const state = () => page.evaluate(() => window.hfwBrowserFixture.messengerState());
  await page.tap('#messenger');
  await page.waitForTimeout(400);
  assert.deepEqual((await state()).went, ['here /messages/'], 'A tap on the Messenger button went nowhere');
  await page.click('#messenger');
  assert.deepEqual((await state()).went, ['here /messages/'], 'A click on the Messenger button went nowhere');
  await page.focus('#messenger');
  await page.keyboard.press('Enter');
  const keyed = await state();
  assert.deepEqual(keyed.went, ['here /messages/'], 'Enter on the Messenger button went nowhere');
  assert.equal(keyed.seen, 0, "A press reached Facebook's own listeners");
  return keyed;
}

// Tab goes from the seller's name to View profile in its shadow root, then on out of it.
async function sellerLink(page) {
  const drawn = await page.evaluate(() => window.hfwBrowserFixture.prepareSeller());
  const focus = () => page.evaluate(() => window.hfwBrowserFixture.sellerFocus());
  await page.focus('#name');
  await page.keyboard.press('Tab');
  assert.equal(await focus(), 'view', 'Tab from the name does not reach View profile');
  await page.keyboard.press('Tab');
  assert.equal(await focus(), 'after', 'Tab does not leave View profile for the next link');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focus(), 'name', 'Shift+Tab does not come back to the name');
  return drawn;
}

// Hide parts of the page, pointed at and clicked for real: the outline follows the pointer, a
// post is refused, a picked box shows hidden, and the page hears nothing until Save.
async function hideParts(page, engine) {
  const fixture = (name, args) => page.evaluate(({ name: method, args: options }) => window.hfwBrowserFixture[method](options), { name, args });
  const near = (one, two) => Boolean(one && two) && ['left', 'top', 'width', 'height'].every((side) => Math.abs(one[side] - two[side]) < 1.5);
  assert.equal((await fixture('preparePicker')).focused, true, 'Pick a part to hide did not take focus');
  await page.keyboard.press('Enter');
  let seen = await fixture('pickerState');
  assert.equal(seen.dialogOpen, false, 'The panel stayed open over the page');
  assert.equal(seen.barFocused, true, "The panel's closing took focus from the picker's bar");
  assert.equal(seen.openerFocused, false, 'Focus went back to what opened the panel');

  // Escape on the bar ends it, though keepKeysInPanel stops every key from the panel.
  await page.keyboard.press('Escape');
  seen = await fixture('pickerState');
  assert.equal(seen.picker, false, 'Escape on the bar did not end the picker');
  assert.equal(seen.dialogOpen, true, 'Escape did not bring the panel back');
  assert.equal((await fixture('focusPick')).focused, true);
  await page.keyboard.press('Enter');
  assert.equal((await fixture('pickerState')).barFocused, true, 'Picking again did not focus the bar');

  // Tab and Shift+Tab stay on the bar: Cancel is its one button while pointing.
  for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert.equal((await fixture('pickerState')).focused, 'picker:cancel', `${key} left the bar`);
  }

  // The bar starts over the top bar and steps to the bottom once the pointer is on something it
  // covers, so the top bar's tabs can be pointed at. The fixed footer sends it back up. Single
  // moves, since every point a stepped move passes can move the bar.
  const topbar = await fixture('pointAt', { id: 'topbar', corner: true });
  await page.mouse.move(topbar.x, topbar.y);
  assert.equal((await fixture('pickerState')).barLow, true, 'The bar stayed over the top bar');
  const tab = await fixture('pointAt', { id: 'watch-tab' });
  await page.mouse.move(tab.x, tab.y);
  assert.ok(near((await fixture('pickerState')).outline, tab.rect), 'A tab under the bar cannot be pointed at');
  const footer = await fixture('pointAt', { id: 'footer', corner: true });
  await page.mouse.move(footer.x, footer.y);
  assert.equal((await fixture('pickerState')).barLow, false, 'The bar stayed over the footer');
  await page.mouse.move(topbar.x, topbar.y);

  // An icon in a link outlines its row, and a padded box outlines itself.
  const icon = await fixture('pointAt', { id: 'market-icon' });
  await page.mouse.move(icon.x, icon.y);
  seen = await fixture('pickerState');
  assert.ok(near(seen.outline, await fixture('boxOf', 'market-row')), 'The outline is not on the shortcut row under the pointer');
  const requests = await fixture('pointAt', { id: 'requests', corner: true });
  await page.mouse.move(requests.x, requests.y, { steps: 4 });
  seen = await fixture('pickerState');
  assert.ok(near(seen.outline, requests.rect), 'The outline is not on the box under the pointer');

  // A post is refused with a red outline, and Pick another goes back to pointing.
  const post = await fixture('pointAt', { id: 'post-text' });
  await page.mouse.click(post.x, post.y);
  seen = await fixture('pickerState');
  assert.equal(seen.outline?.refused, true, 'A refused pick has no red outline');
  assert.match(seen.title, /part of a post/);
  assert.equal(seen.focused, 'picker:again');
  await page.keyboard.press('Enter');
  seen = await fixture('pickerState');
  assert.equal(seen.barFocused, true, 'Pick another did not go back to pointing');

  // The box is picked and shows hidden at once, with Save ready for Enter.
  await page.mouse.move(requests.x, requests.y);
  await page.mouse.click(requests.x, requests.y);
  seen = await fixture('pickerState');
  assert.equal(seen.focused, 'picker:save', 'Save did not take focus after a pick');
  assert.equal(await fixture('displayOf', 'requests'), 'none', 'The picked box does not show hidden');
  assert.deepEqual(seen.heard, [], 'The page heard the pointer while picking');
  await page.screenshot({ path: join(output, `${engine}-hide-parts-picked.png`), animations: 'disabled' });
  await page.keyboard.press('Enter');
  seen = await fixture('pickerState');
  assert.equal(seen.picker, false);
  assert.equal(seen.preview, false, 'The preview style stayed after Save');
  assert.equal(seen.dialogOpen, false, 'Save opened the panel over the page');
  assert.equal(seen.parts, 'complementary link /friends/requests/ up 1 on home', 'The rule is not kept to the page it was picked on');
  assert.match(seen.toast, /Part hidden/);
  assert.equal(seen.undo, true, 'The save has no Undo');
  const saved = await fixture('savedPart');
  assert.equal(saved.matched, 1);
  assert.equal(saved.cssHidesMatched, true, "The saved CSS hides something the matcher doesn't find");
  assert.equal(saved.selectorAgrees, true, "The browser's selector engine and the matcher disagree");
  assert.equal(saved.styleHasRule, true, 'The feature style lacks the saved rule');
  assert.equal(saved.afterReload, true, 'Settings read back from storage build different CSS');
  assert.notEqual(await fixture('displayOn', { id: 'requests', route: 'groups' }), 'none', 'A part hidden on Home is hidden on Groups too');
  const withPost = await fixture('postInto', 'requests');
  assert.notEqual(withPost.withPost, 'none', 'A post that turned up in the hidden part stayed hidden');
  assert.equal(withPost.after, 'none', 'The part did not hide again once the post was gone');

  // Clicks reach the page again.
  await fixture('clearHeard');
  const sponsored = await fixture('pointAt', { id: 'sponsored', corner: true });
  await page.mouse.click(sponsored.x, sponsored.y);
  seen = await fixture('pickerState');
  assert.ok(seen.heard.includes('click'), 'The page still hears no clicks after Save');

  // The card lists the part with a Show again named for it, and a real click on it shows the part.
  const list = await fixture('showList');
  assert.equal(list.items, 1);
  assert.equal(list.named, true, 'Show again is not named for its part');
  await page.screenshot({ path: join(output, `${engine}-hide-parts-list.png`), animations: 'disabled' });
  await page.mouse.click(list.button.left + list.button.width / 2, list.button.top + list.button.height / 2);
  seen = await fixture('pickerState');
  assert.equal(seen.parts, '');
  assert.notEqual(await fixture('displayOf', 'requests'), 'none', 'Show again left the part hidden');
  assert.match(seen.toast, /shows again/);
  assert.deepEqual(seen.errors, []);
  return { line: saved.line, matched: saved.matched };
}

async function run() {
  for (const engine of [chromium, firefox]) {
    const name = engine.name();
    try { activeBrowser = await engine.launch({ headless: true, timeout: 15000 }); }
    catch (error) { throw new Error(`Cannot launch ${name}. Install its runtime with: npx playwright install chromium firefox`, { cause: error }); }
    try {
      console.log(`${name} ${activeBrowser.version()}`);
      for (const scenario of chosen) {
        const started = Date.now();
        await within(SCENARIO_MS, `${name} ${scenario.id}`, async () => {
          const context = await activeBrowser.newContext({ viewport: scenario.viewport ?? { width: 360, height: 760 }, serviceWorkers: 'block', hasTouch: Boolean(scenario.touch) });
          try {
            context.setDefaultTimeout(5000);
            await context.route('**/*', (route) => {
              const requested = new URL(route.request().url());
              return requested.origin === origin ? route.continue() : route.abort('blockedbyclient');
            });
            await context.routeWebSocket('**/*', (socket) => socket.close());
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(origin, { waitUntil: 'load', timeout: 5000 });
            await page.waitForFunction(() => Boolean(window.hfwBrowserFixture));
            const detail = DRIVEN[scenario.fixture]
              ? await DRIVEN[scenario.fixture](page, name)
              : await page.evaluate(({ fixture, ...options }) => window.hfwBrowserFixture[fixture](options), scenario);
            assert.deepEqual(errors, [], `${name} ${scenario.id} raised a page error`);
            if (scenario.screenshot) await page.screenshot({ path: join(output, `${name}-${scenario.id}.png`), animations: 'disabled' });
            results.push({ browser: name, scenario: scenario.id, detail });
          } finally { await context.close(); }
        });
        console.log(`PASS ${name} ${scenario.id} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      }
    } finally { await activeBrowser.close(); activeBrowser = null; }
  }
}

try {
  await run();
  await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Passed ${results.length} local browser scenarios. Screenshots: ${output}`);
} catch (error) {
  console.error(error.stack ?? error);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
} finally {
  await activeBrowser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
