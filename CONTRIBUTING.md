# Contributing

Thanks for helping. Here's how the code fits together.

## Layout

```
src/
  main.js              boot order: settings, network hooks, features, styles, panel
  core/
    env.js             which window we're in and what the userscript manager offers
    settings.js        settings built from the feature list, with import and export
    storage.js         GM storage, with localStorage and in-memory fallbacks
    log.js             console logging plus the buffer Diagnostics shows
    net/hooks.js       fetch, XHR, sendBeacon and JSON.parse hooks
    net/payload.js     Facebook's multi-document responses, line by line
    url.js             link-shim unwrapping and tracking tag removal
    style.js           one style element for every CSS feature that's on
  features/            one file per feature, grouped by settings section
  ui/                  the settings panel (closed shadow root, no innerHTML)
scripts/               build, metadata block, version check
tests/                 node:test suites, no browser needed
docs/feature-parity.md every Hushfacebook patch and its web plan
```

## Adding a feature

Make a file under `src/features/<section>/`, add it to `src/features/index.js` and give it a row in `docs/feature-parity.md`. A feature is a plain object:

```js
export default {
  id: 'hideStoriesTray',        // settings key, never renamed once released
  section: 'feed',              // see src/features/sections.js
  android: 'Hide Stories tray', // the Hushfacebook patch it matches
  title: 'Hide Stories tray',
  description: 'What it does, in a sentence or two.',
  default: false,
  needsPage: false,             // true if it hooks Facebook's window
  css: '...',                   // optional, applied while it's on
  setup(ctx) {},                // optional, runs once at document-start
};
```

`ctx.enabled()` tells you whether the feature is on right now. Check it every time your code runs rather than once at setup, so switching it off works without a reload.

Prefer the network layer when the thing you're removing arrives as data, because Facebook's markup changes much more often than its data. Use `markers` on response rules so documents without them aren't parsed.

## Text people read

Titles, descriptions, toasts and docs should read like a person wrote them. Keep them plain and short. No em dashes or semicolons, and use contractions. The feature test checks the panel text for dashes and semicolons.

## Fixtures

Fixtures in `tests/` are synthetic for now. If you capture a real Facebook response to test against, scrub it first: no names, profile IDs, photo URLs, tokens or anything else that points at a person. Keep raw captures in `captures/`, which git ignores.

## Checks

```
npm test
npm run check
npm run build
```

Then install `dist/hushfacebook-web.user.js` in Violentmonkey or Tampermonkey and try the feature on facebook.com. Note what you checked in the pull request.
