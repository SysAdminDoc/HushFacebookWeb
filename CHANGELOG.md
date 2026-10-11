# Changelog

## Unreleased

* Checked in Violentmonkey on Chrome as well as Tampermonkey. The script starts in the page, takes Marketplace and search ads out before Facebook sees them, gives Copy link the post's own address and keeps a story view to yourself, the same as in Tampermonkey.
* The tests now run against scrubbed copies of what Facebook really sends: a feed page, the home page's inline feed data, a Marketplace page with an ad card, a search page with an ad, and the request that marks a story as seen. A new script turns a raw capture into one of these fixtures, replacing ids, names, places, text, tokens and links with stand-ins keyed by a private key, and a test checks every fixture for leftover ids, tokens, places and addresses.
* Groundwork for hiding posts on the page itself, for the features that can't catch a post in Facebook's data. It never marks the feed's own rows, which is what stalls scrolling in other blockers. Diagnostics counts hidden posts by reason. There's also a new General setting that leaves a one-line "Hidden: Sponsored. Show" note where a post was, and clicking it brings the post back.
* Search ads and Marketplace ad cards have their own switches now, like on Android, and there's a new Hide sponsored reels switch that drops the ad breaks Facebook schedules inside videos and reels. All three are on by default. Every ad rule lives in one table that says where it was seen and what it removes.
* Checked the rest of the share sheet with Sanitize sharing links on. Share to WhatsApp gets the post's own address too, and sharing through Messenger, to a group or to a friend's profile works the same as without the script.
* Hide sponsored posts has a second layer. If an ad still gets drawn, the script reads the post's header the way you see it and hides the post when it says Sponsored or Ad. It sees through the ways Facebook disguises that label, like letters that are shuffled and put back in place by the layout with hidden decoys mixed in, or a label that points at text Facebook deletes a moment later. A post with only a Shop now style button isn't hidden, since group posts and shares carry those too. This layer works even when your manager runs the script as a content script, so Hide sponsored posts no longer switches off there. English labels only for now. Diagnostics shows how many ads each layer caught.
* Facebook Feed Filter's MIT license notice is in THIRD_PARTY_NOTICES.txt and at the end of the built script, since the page-side ad check follows its approach.
* New Hide Stories tray switch. It takes the Stories row off the top of Home, along with the "What's on your mind?" box unless you turn that part off, and the first post moves up into the space. It's off by default.
* New Hide suggested posts switch, on by default. Posts from Pages, people and groups you don't follow come out of Home and your groups feed before Facebook draws them, and any that slip through, or all of them in content mode, are hidden by the Follow or Join button next to the name. Search results, a Page's own posts and groups you're browsing aren't touched.
* New Hide reel rows in the feed switch for the rows of reels Facebook puts between posts. Reels your friends post stay. It's off by default.
* Hidden posts and rows can now be any block in the feed, not only posts.
* Facebook's home.php address counts as Home now, so Home-only features work there too.
* Releases now come with a SHA256SUMS.txt, so you can check that the script you downloaded is the one that was built.

## v0.0.1 (2026-10-10)

* The groundwork. Settings live in your userscript manager and get their own panel, which can back them up and show diagnostics. Underneath, a data layer cleans Facebook's feed as it loads and can hold back single requests.
* First features: Hide sponsored posts, View stories anonymously, Sanitize sharing links, Skip Facebook's link redirect, Following feed on Home, Tap to play and Turn off HDR brightness. All seven have run on facebook.com, and the script has been checked installed in Tampermonkey on Chrome.
* If two copies of the script are installed, the second one stays out of the way and the first one says so.
* Hide sponsored posts follows how Facebook marks ads as of October 2026. It now renames its ad fields and scrambles the post category, so the old markers would have missed every ad. The same switch also covers Marketplace ad cards and ads in search results.
* Copy link gives the post's own address. Without it, Facebook hands out a facebook.com/share link that leads back to whoever copied it.
* Tap to play starts a video only when you click that video. Clicking anywhere else, like the Reels link, no longer lets the next one start by itself.
* The settings switch at the top of the panel now reads on while the script is running.
