// The panel's two color sets: words read at 4.5:1 or better on every surface they sit on, and
// control edges and the status dot at 3:1 (WCAG 1.4.3 and 1.4.11), on Facebook's light mode and
// on its dark one. The pairs are the ones src/ui/styles.js draws.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrast } from '../src/features/appearance/accent.js';
import { panelCss, uiLightTokens, uiTokens } from '../src/ui/styles.js';

const tokens = (css) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]+)/g)].map(([, name, value]) => [name, value]));

const PAIRS = [
  // Rows, notes, errors, the log and the footer.
  { on: ['base', 'mantle', 'crust', 'surface0'], colors: ['text', 'subtext', 'accent', 'red', 'peach'], least: 4.5 },
  // The current page in the menu, the reload card and the setup tiles.
  { on: ['selected', 'tile-top', 'tile-hover'], colors: ['text', 'subtext', 'accent'], least: 4.5 },
  { on: ['accent'], colors: ['accent-ink'], least: 4.5 },
  // The search box's placeholder, drawn at full strength.
  { on: ['crust'], colors: ['placeholder'], least: 4.5 },
  // Switch, field and button edges, the on switch and an invalid field's edge.
  { on: ['base', 'surface0', 'crust'], colors: ['control', 'accent', 'red'], least: 3 },
  // The status dot, on the brand row's card.
  { on: ['base', 'mantle', 'surface0'], colors: ['green'], least: 3 },
];

for (const [mode, css] of [['dark', uiTokens], ['light', uiLightTokens]]) {
  test(`the ${mode} panel's words and controls stand out from what they sit on`, () => {
    const set = tokens(css);
    for (const { on, colors, least } of PAIRS) {
      for (const background of on) {
        for (const color of colors) {
          assert.match(set[color] ?? '', /^#[0-9a-f]{6}$/i, `${mode} has a solid --${color}`);
          assert.match(set[background] ?? '', /^#[0-9a-f]{6}$/i, `${mode} has a solid --${background}`);
          const ratio = contrast(set[color], set[background]);
          assert.ok(ratio >= least, `${mode}: --${color} on --${background} is ${ratio.toFixed(2)}:1, under ${least}:1`);
        }
      }
    }
  });
}

test('the light set gives every color the dark one has, so nothing stays dark on a light page', () => {
  assert.deepEqual(Object.keys(tokens(uiLightTokens)).sort(), Object.keys(tokens(uiTokens)).sort());
});

// The page's own rule hands every control the text color, which hides the browser's own grayed
// look, so the panel draws one. Reset, Restore and Quick setups turn every button and field off
// while they run.
test("a button or field that can't be used right now looks it, and doesn't light up under the pointer", () => {
  const rules = [...panelCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selectors, body]) => [selectors.split(',').map((each) => each.trim()), body]);
  const ruleFor = (selector) => rules.filter(([selectors]) => selectors.includes(selector)).map(([, body]) => body).join(' ');
  for (const selector of ['.button:disabled', '.options select:disabled', '.options input:disabled', '.options textarea:disabled']) {
    assert.match(ruleFor(selector), /opacity: 0\.55;/, selector);
    assert.match(ruleFor(selector), /cursor: not-allowed;/, selector);
  }
  assert.match(ruleFor('.button:not(.primary):disabled:hover'), /background: transparent;/);
  assert.match(ruleFor('.button.primary:disabled:hover'), /filter: none;/);
});

test("the search placeholder isn't faded below its color, and the dialog veil has a color where variables don't reach it", () => {
  const placeholder = /\.search::placeholder \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
  assert.match(placeholder, /color: var\(--placeholder\)/);
  assert.match(placeholder, /opacity: 1;/);
  const veil = /\.dialog::backdrop \{([^}]*)\}/.exec(panelCss)?.[1] ?? '';
  assert.match(veil, new RegExp(`background: var\\(--backdrop, ${tokens(uiTokens).backdrop}\\)`));
});
