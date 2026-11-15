// Which of Facebook's modes the page is in, read off the class on <html>, and kept up with as
// Facebook or Force dark mode swaps it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { DARK, LIGHT } from '../src/features/appearance/force-dark.js';
import { pageTheme, watchPageTheme } from '../src/ui/page-theme.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
const page = (classes = '') => {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  if (classes) win.document.documentElement.className = classes;
  return win;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the page is light only with Facebook light class, and dark with the dark class or none yet', () => {
  assert.equal(pageTheme(page(LIGHT).document), 'light');
  assert.equal(pageTheme(page(`${DARK} other`).document), 'dark');
  assert.equal(pageTheme(page().document), 'dark');
  assert.equal(pageTheme(null), 'dark');
});

test('the watch says the mode at once, again on each switch, not for other class changes, and stops when told', async () => {
  const win = page(DARK);
  const html = win.document.documentElement;
  const seen = [];
  const stop = watchPageTheme(win.document, (theme) => seen.push(theme));
  assert.deepEqual(seen, ['dark']);
  html.classList.replace(DARK, LIGHT);
  await settle();
  html.classList.add('something-else');
  await settle();
  html.classList.replace(LIGHT, DARK);
  await settle();
  assert.deepEqual(seen, ['dark', 'light', 'dark']);
  stop();
  html.classList.replace(DARK, LIGHT);
  await settle();
  assert.deepEqual(seen, ['dark', 'light', 'dark']);
});
