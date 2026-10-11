# Changelog

## Unreleased

* Checked in Violentmonkey on Chrome as well as Tampermonkey. The script starts in the page, takes Marketplace and search ads out before Facebook sees them, gives Copy link the post's own address and keeps a story view to yourself, the same as in Tampermonkey.
* The tests now run against scrubbed copies of what Facebook really sends: a feed page, the home page's inline feed data, a Marketplace page with an ad card, a search page with an ad, and the request that marks a story as seen. A new script turns a raw capture into one of these fixtures with every id, name, piece of text, token and link replaced, and a test checks that nothing personal is left in them.

## v0.0.1 (2026-10-10)

* The groundwork. Settings live in your userscript manager and get their own panel, which can back them up and show diagnostics. Underneath, a data layer cleans Facebook's feed as it loads and can hold back single requests.
* First features: Hide sponsored posts, View stories anonymously, Sanitize sharing links, Skip Facebook's link redirect, Following feed on Home, Tap to play and Turn off HDR brightness. All seven have run on facebook.com, and the script has been checked installed in Tampermonkey on Chrome.
* If two copies of the script are installed, the second one stays out of the way and the first one says so.
* Hide sponsored posts follows how Facebook marks ads as of October 2026. It now renames its ad fields and scrambles the post category, so the old markers would have missed every ad. The same switch also covers Marketplace ad cards and ads in search results.
* Copy link gives the post's own address. Without it, Facebook hands out a facebook.com/share link that leads back to whoever copied it.
* Tap to play starts a video only when you click that video. Clicking anywhere else, like the Reels link, no longer lets the next one start by itself.
* The settings switch at the top of the panel now reads on while the script is running.
