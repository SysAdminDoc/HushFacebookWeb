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
  ...['subclass', 'proxy', 'getter'].flatMap((wrapper) => ['before', 'after'].map((order) => ({ id: `xhr-${wrapper}-${order}`, fixture: 'network', wrapper, order }))),
  { id: 'delayed-bridge', fixture: 'delayedBridge' },
  { id: 'dialog-search-undo', fixture: 'panel' },
  { id: 'staged-share', fixture: 'stagedShare', screenshot: true },
  { id: 'recycled-posts', fixture: 'recycledPosts', screenshot: true },
  { id: 'bounded-download', fixture: 'boundedDownload' },
];
const results = [];
let activeBrowser;
let timer;

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

async function run() {
  for (const engine of [chromium, firefox]) {
    const name = engine.name();
    try { activeBrowser = await engine.launch({ headless: true, timeout: 15000 }); }
    catch (error) { throw new Error(`Cannot launch ${name}. Install its runtime with: npx playwright install chromium firefox`, { cause: error }); }
    try {
      console.log(`${name} ${activeBrowser.version()}`);
      for (const scenario of scenarios) {
        const context = await activeBrowser.newContext({ viewport: { width: 360, height: 760 }, serviceWorkers: 'block' });
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
          const detail = scenario.fixture === 'panel'
            ? await panel(page, name)
            : await page.evaluate(({ fixture, ...options }) => window.hfwBrowserFixture[fixture](options), scenario);
          assert.deepEqual(errors, [], `${name} ${scenario.id} raised a page error`);
          if (scenario.screenshot) await page.screenshot({ path: join(output, `${name}-${scenario.id}.png`), animations: 'disabled' });
          results.push({ browser: name, scenario: scenario.id, detail });
          console.log(`PASS ${name} ${scenario.id}`);
        } finally { await context.close(); }
      }
    } finally { await activeBrowser.close(); activeBrowser = null; }
  }
}

try {
  await Promise.race([
    run(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser regressions exceeded 90 seconds')), 90000); }),
  ]);
  await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Passed ${results.length} local browser scenarios. Screenshots: ${output}`);
} catch (error) {
  console.error(error.stack ?? error);
  if (error.cause) console.error(error.cause.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await activeBrowser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
