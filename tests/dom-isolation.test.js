// The test pages from tests/helpers/dom.js load nothing by themselves. A loopback server stands
// in for the addresses fixtures carry, and the same page with loading turned back on shows the
// server would have heard.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function canary() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const css = req.url.includes('.css');
    res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html' });
    res.end(css ? 'p { color: red; }' : '<!doctype html><p>frame</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { hits, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// What Facebook markup brings along, added the way page code adds it.
async function loadEverything(win, base, run) {
  const { document } = win;
  const add = (parent, tag, attributes) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    parent.appendChild(element);
  };
  add(document.head, 'link', { rel: 'stylesheet', href: `${base}/link.css?run=${run}` });
  const style = document.createElement('style');
  style.textContent = `@import url("${base}/import.css?run=${run}");`;
  document.head.appendChild(style);
  add(document.head, 'script', { src: `${base}/script.js?run=${run}` });
  add(document.body, 'iframe', { src: `${base}/frame.html?run=${run}` });
  add(document.body, 'img', { src: `${base}/image.png?run=${run}` });
  document.body.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${base}/markup.css?run=${run}"><iframe src="${base}/markup-frame.html?run=${run}"></iframe>`);
  const fetched = await win.fetch(`${base}/fetch?run=${run}`).then((response) => response.status, () => 'rejected');
  const xhr = new win.XMLHttpRequest();
  const ended = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
  xhr.open('GET', `${base}/xhr?run=${run}`);
  xhr.send();
  await ended;
  win.location.href = `${base}/navigate?run=${run}`;
  await win.happyDOM.waitUntilComplete();
  await settle(150);
  return { fetched, xhr: xhr.status };
}

// happy-dom runs a synchronous XHR in a child process and blocks this one until it ends, so the
// loopback server here could never answer it. Only the offline page tries one.
function syncXhr(win, url) {
  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.send();
  return xhr.status;
}

test('a test page sends nothing to a server: no stylesheet, script, iframe, image, fetch, XHR or navigation', async () => {
  const { hits, base, close } = await canary();
  const ran = (run) => hits.filter((hit) => hit.endsWith(`run=${run}`)).map((hit) => hit.split('?')[0]).sort();
  try {
    // The positive control: the same page with stylesheets, iframe pages (a child frame
    // navigation as well) and fetch let out. happy-dom 21 never fetches an @import, so the
    // control can't show that one.
    const open = testWindow(`${base}/page`, {
      enableCSSFileLoading: true,
      enableIframePageLoading: true,
      navigation: { disableChildFrameNavigation: false },
      fetch: { interceptor: null },
    });
    await loadEverything(open, base, 'open');
    await open.happyDOM.close();
    assert.ok(ran('open').includes('/link.css'), `the control reached the server: ${ran('open')}`);
    assert.ok(ran('open').includes('/frame.html'), `the control reached the server: ${ran('open')}`);
    assert.ok(ran('open').includes('/fetch'), `the control reached the server: ${ran('open')}`);
    assert.ok(ran('open').includes('/xhr'), `the control reached the server: ${ran('open')}`);

    const win = testWindow(`${base}/page`);
    const answers = await loadEverything(win, base, 'test');
    const synchronous = syncXhr(win, `${base}/sync-xhr?run=test`);
    await settle(150);
    assert.deepEqual(ran('test'), [], 'nothing reached the server');
    assert.equal(answers.fetched, 0, 'a fetch gets an error answer');
    assert.equal(answers.xhr, 0, 'and so does an XHR');
    assert.equal(synchronous, 0, 'a synchronous one too');
    assert.equal(win.location.href, `${base}/navigate?run=test`, 'a change of address just sets it');
    await win.happyDOM.close();

    // The refused fetch also covers the files a page loads, so each switch is checked with
    // fetch let out as well.
    const layered = testWindow(`${base}/page`, { fetch: { interceptor: null } });
    await loadEverything(layered, base, 'layered');
    await layered.happyDOM.close();
    assert.deepEqual(ran('layered'), ['/fetch', '/xhr'], 'only what the page asked for itself');
  } finally {
    await close();
  }
});

test('every test page comes from tests/helpers/dom.js', async () => {
  const folder = new URL('./', import.meta.url);
  const names = (await readdir(folder, { recursive: true })).map((name) => name.replaceAll('\\', '/'))
    .filter((name) => name.endsWith('.js') && name !== 'helpers/dom.js');
  assert.ok(names.length > 30, String(names.length));
  for (const name of names) {
    const text = await readFile(new URL(name, folder), 'utf8');
    assert.doesNotMatch(text, /from ["']happy-dom["']|new Window\(/, name);
  }
});
