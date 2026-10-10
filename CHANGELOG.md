# Changelog

## Unreleased

* The groundwork. Settings live in your userscript manager and get their own panel, which can back them up and show diagnostics. Underneath, a data layer cleans Facebook's feed as it loads and can hold back single requests.
* First features: Hide sponsored posts, View stories anonymously, Sanitize sharing links, Skip Facebook's link redirect, Following feed on Home, Tap to play and Turn off HDR brightness. They still need a check on facebook.com before the first release.
* If two copies of the script are installed, the second one stays out of the way and the first one says so.
* Hide sponsored posts follows how Facebook marks ads as of October 2026. It now renames its ad fields and scrambles the post category, so the old markers would have missed every ad. The same switch also covers Marketplace ad cards and ads in search results.
