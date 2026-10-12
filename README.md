![HushFacebook Web. A quieter Facebook feed.](assets/readme-hero.png)

<p>
  <img src="https://img.shields.io/badge/version-0.0.4-CBA6F7" alt="Version 0.0.4">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/platform-userscript%20%7C%20Chrome%20extension-1877F2" alt="Platform userscript or Chrome extension">
  <img src="https://img.shields.io/badge/for-Tampermonkey%20%7C%20Violentmonkey-00485B" alt="For Tampermonkey or Violentmonkey">
</p>

<p>
  <a href="https://ko-fi.com/X8K126YVER">
    <img height="42" src="https://storage.ko-fi.com/cdn/kofi2.png?v=3" alt="Buy me a coffee on Ko-fi" />
  </a>
</p>

# HushFacebook Web

HushFacebook Web is a userscript for Facebook in a desktop browser, and a Chrome extension built from the same code. It's the web sibling of [Hushfacebook](https://github.com/SysAdminDoc/HushFacebook), the patch bundle for the Android app, and it's working toward the same list: a feed without ads or suggested posts, less Meta AI, downloads, privacy switches and playback controls.

## Where it stands

It's still early. The current development build is 0.0.4. The latest published release is 0.0.2.

There's a settings panel and a layer that filters Facebook's data as it loads. These features are available.

* Hide sponsored posts
* Hide suggested posts
* Hide reel rows in the feed
* Hide Stories tray
* Hide posts by words
* Hide seen posts
* Hide AI-detected posts
* Show full post dates
* Keep your place in the feed
* Hide Follow and Join buttons
* Expand long posts
* Hide sponsored reels
* Don't send watch history
* Clean up Reels
* Hide sponsored search results
* Hide sponsored Marketplace listings
* View profile on Marketplace sellers
* Hide read receipts
* Hide typing indicator
* Hide kinds of notifications
* Default comment order
* Show every reply
* Hide GIF and sticker buttons
* Hide that you're writing a comment
* Tag suggestions only after @
* Show comments as written
* View stories anonymously
* Hold back usage logs
* Block Instant Games ads (experimental)
* Stop stories moving on
* Sanitize sharing links
* Skip Facebook's link redirect
* Trim the share menu
* Download any photo, video, reel or story
* Following feed on Home
* Open on a chosen tab
* Marketplace only
* Open Messenger as a full page
* Tap to play
* Turn off HDR brightness
* Resume long videos
* Keep your video speed
* Remember your volume
* Hold a reel for 2x
* Picture-in-picture button
* Keep video controls on screen
* Default video quality
* Force dark mode
* AMOLED black theme
* Accent color
* Use the system font
* Use your computer's emoji
* Turn off screen transitions
* Hide tabs
* Hide tab badges
* Hide Menu promotions
* Hide Meta upsells
* Hide Facebook's own cards and tips
* Custom CSS
* Settings in your account menu

The script has been checked on facebook.com in Chrome with Tampermonkey and Violentmonkey. In both, it runs in the page, removes Marketplace and search ads, copies a post's own address, keeps story views private and remembers settings. Some cases still need real examples. Feed ads and rows of reels haven't appeared during those checks, and plain video downloads haven't been exercised. Read receipt and typing switches can't reach end-to-end encrypted chats. The other features have also run on facebook.com, but haven't all been checked in both managers.

[docs/feature-parity.md](docs/feature-parity.md) goes through every Hushfacebook patch and says what the web version will do with it.

## The settings panel

Click the sliders button in the bottom left corner of Facebook, or the HushFacebook Web row in the menu under your profile picture at the top right. Your userscript manager's menu has a HushFacebook Web settings entry too, and in the extension the toolbar button opens them from any tab. Changes save as you make them, and every switch has a line under it saying what it does. If you'd rather not have the corner button, turn it off under Menu or General.

The panel has 18 sections in a dark layout with a lavender accent. Find a setting, above the sections, looks through every switch's name, description and options as you type, and each result's section link opens that section with the switch in view. Narrow windows get a scrolling section bar, and long labels and options wrap to fit. The power switch pauses the script. General has backup and restore, and Reset offers Undo in a notification. Closing settings returns focus to the control that opened them.

Backups restore your saved choices, including defaults. Restore accepts HushFacebook Web format 1 files up to 1 MB. Older plain settings files apply only the choices they contain. If a save fails, the previous choices stay in use and you can retry.

<p>
  <img src="assets/screenshots/panel-feed.png" width="49%" alt="The redesigned News feed settings with lavender switches and word filter options">
  <img src="assets/screenshots/panel-downloads.png" width="49%" alt="The redesigned Downloads settings for photos, videos, reels and stories">
</p>

These screenshots show the current development build in a browser preview. All 18 sections were checked at desktop size and at 320, 360 and 640 pixels wide. On signed-in Facebook in Chrome the panel, search and section links were checked at desktop size and 400 pixels wide. Firefox hasn't been checked yet.

## How it works

Most Facebook cleanup tools hunt for posts on the page and hide them. That breaks whenever Facebook reshuffles its markup, which is often. HushFacebook Web works a layer lower where it can. Facebook's site loads its feed as data, both inline with the page and in the background as you scroll, and the script removes ads from that data before Facebook draws anything. The aim is no gap where an ad was and no flash of it on screen.

Some things can only be done on the page itself, like download buttons or hiding a menu item. Those use the page, kept to the parts of Facebook's markup that change least.

Your userscript manager, or the extension's own storage, keeps a separate set of settings for each Facebook account. Downloads request the media you choose to save, and the manager checks GitHub for script updates. Diagnostics reports include changed settings and recent log details, so read them before sharing. If a manager has no storage of its own, the script falls back to page storage, which Facebook may clear.

Block Instant Games ads is off by default under Meta's other products. It answers supported ad requests with the game's usual no-ad response. Games with protected ad methods can't be filtered. A game that replaces or adds its ad system can make unfiltered requests before the next check. Rewards that require an ad won't be earned. A game can't read your Facebook account settings, so games share one switch using the account you last opened or changed it in. This needs manager storage and page mode. Reload an open game after changing it. Local SDK and frame checks pass, but it hasn't been checked in a live game yet.

## Install

There are two ways to run it. They share every feature, so pick one, not both. If both are on, the one that starts second stays out of the way, and the script's log says so.

### As a userscript

You'll need a userscript manager first:

* [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) in Chrome, Edge, Firefox or another desktop browser. It's been checked in both on Chrome. Firefox hasn't been checked yet.
* In Chrome 138 or newer, open the manager's extension details and turn on **Allow User Scripts**. Chrome won't run any userscript without it.

Then open [hushfacebook-web.user.js](https://github.com/SysAdminDoc/HushFacebookWeb/releases/latest/download/hushfacebook-web.user.js) and your manager will offer to install it. It checks for updates on its own.

Open the settings from the round button in Facebook's bottom-left corner, from the menu under your profile picture, or from your userscript manager's menu.

### As a Chrome extension

This works in Chrome, Edge, Brave and other Chromium browsers from version 111. No userscript manager needed, and there's no Allow User Scripts switch to find.

1. Download `hushfacebook-web-extension.zip` from a release and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.

The extension is new in the development build, so the first release to carry the zip is the one after 0.0.2. Until then, build it yourself (below) and load `dist/extension`. It doesn't update itself yet. Load the new folder when a release comes out, and your settings stay where they are.

The toolbar button opens the settings on Facebook, or opens Facebook with the settings up from any other tab. It asks for storage (your settings), downloads (saving photos and videos) and the tab you click the button on. It runs only on facebook.com and in Instant Games frames.

So far the extension has been checked in Chromium on Facebook while signed out. It loads, keeps settings, saves files under their readable names, and its toolbar button and Home redirects work. The signed-in checks listed above ran with the userscript, which uses the same feature code.

## Building it yourself

You need Node 24.

```
npm install
npm run build
```

That writes `dist/hushfacebook-web.user.js`, which you open in your userscript manager to install. It also writes the extension, unpacked in `dist/extension` and zipped as `dist/hushfacebook-web-extension.zip`. `npm test` runs the tests and `npm run check` runs the lint and version checks. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the code is laid out.

## Thanks

These projects showed what works on Facebook's site and what doesn't: [FB Clean my feeds](https://github.com/Artificial-Sweetener/facebook-clean-my-feeds), [Social Fixer](https://www.socialfixer.com/), [F.B. Purity](https://www.fbpurity.com/), uBlock Origin's Facebook filters, [Privacy Badger](https://github.com/EFForg/privacybadger) and [ClearURLs](https://github.com/ClearURLs/Rules). HushFacebook Web is written from scratch and doesn't include their code.

## License

[MIT](LICENSE)
