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
    dom/posts.js       finds posts on the page and reports them to features (post/add, post/remove)
    dom/hide.js        hides a post with a reason, counts it, and can leave a note that shows it again
    style.js           one style element for every CSS feature that's on
  features/            one file per feature, grouped by settings section
  ui/                  the settings panel (closed shadow root, no innerHTML)
scripts/               build, metadata block, version check
tests/                 node:test suites, no browser needed (happy-dom stands in for the page)
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

`tests/fixtures/` holds scrubbed captures of what facebook.com sent on 2026-10-10: a feed page (`CometNewsFeedPaginationQuery`), the home page's inline feed blobs, a Marketplace page with an ad card, a search page with an ad, and the story seen request. `tests/captured.test.js` runs the shipped rules against them. Raw captures stay in `captures/`, which git ignores, because they carry account data.

To add one, run the scrubber over the raw file:

```
node scripts/scrub-fixture.mjs captures/<run>/bodies/<body>.txt --out tests/fixtures/<Name>.jsonl --lines 0,6,22
node scripts/scrub-fixture.mjs captures/<run>/pages/<page>.txt --html --match <text> --index 2 --out tests/fixtures/<name>.jsonl
node scripts/scrub-fixture.mjs captures/<run>/network.jsonl --request --friendly <name> --out tests/fixtures/<name>.request.jsonl
```

It keeps field names, typenames, enum values and the shape of the document. Ids, names, post text, tokens, cursors, hashes and media or profile URLs become stand-ins hashed from the originals, so the same id maps to the same stand-in everywhere in a fixture. `--lines` picks streamed chunks out of a body and `--trim path=0,1` shortens an array, which keeps a fixture small. The scrubber refuses to write a file that still carries a long id, a CDN host, a `pfbid` token or an email, and `tests/fixtures.test.js` checks every fixture for the same things on each run. Read a new fixture yourself before committing it all the same.

## Checks

```
npm test
npm run check
npm run build
```

Then install `dist/hushfacebook-web.user.js` in Violentmonkey or Tampermonkey and try the feature on facebook.com. Note what you checked in the pull request.

## Releasing

Releases go out in stages, and each stage refuses to run until the ones before it have passed for the same version and commit:

```
npm run release -- --stage preflight
npm run release -- --stage build
npm run release -- --stage notes
npm run release -- --stage live
npm run release -- --stage publish
```

Preflight wants a clean `main`, a version that isn't tagged yet and a `## vX.Y.Z` section in CHANGELOG.md, then runs the checks and tests. Build starts from an empty `dist/` and writes `SHA256SUMS.txt` beside the script. Notes copies the whole CHANGELOG section into `dist/release-notes.txt`. Live is optional and only runs on the maintainer's PC, since it drives a signed-in browser. Publish needs `main` pushed, makes the GitHub release with the script, the `.meta.js` and the sums, then downloads the script back and compares it with the build. Add `--dry-run` to publish to see the command first. A new commit, or a changed file in `dist/`, sends you back to the stage that made it.
