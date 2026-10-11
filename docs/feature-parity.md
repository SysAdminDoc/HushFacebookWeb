# Feature parity with Hushfacebook

[Hushfacebook](https://github.com/SysAdminDoc/HushFacebook) patches the Facebook app on Android. This table walks through every one of its patches and says what HushFacebook Web does about it in the browser.

What the status words mean:

* **Tested**: it ran on facebook.com and did its job in a test browser. Separately, Tampermonkey and Violentmonkey on Chrome were checked for running in the page, Marketplace and search ads, Copy link, story views and saved settings.
* **Written**: the code is in the script, but it hasn't been seen doing its job on facebook.com yet, often because the test account hasn't been shown what it removes.
* **Planned**: there's a clear way to do it on the web and it's on the list.
* **Needs research**: it probably has a web version, but someone has to look at how Facebook's site handles it first.
* **Android only**: it fixes something the web doesn't have. The reason is in the last column.

| Android patch | Status | On the web |
|---|---|---|
| Hide sponsored posts | Written | Removes ads from the feed data before Facebook draws it, including the first screen that comes inline with the page. It runs on every page, but the test account hasn't been shown a feed ad to watch it go yet. |
| View stories anonymously | Tested | Holds back the request that tells Facebook you saw a story. |
| Sanitize sharing links | Tested | Strips tracking tags from links you open or copy. Copy link and Share to WhatsApp give the post's own address instead of a facebook.com/share link, and sharing to Messenger, a group or a friend's profile works as before. |
| Open links in external browser | Tested | Becomes "Skip Facebook's link redirect": outside links open directly instead of through l.facebook.com. |
| Tap to play | Tested | Videos only start when you click them. |
| Turn off HDR brightness | Tested | Caps HDR video and photos at normal brightness in browsers that support it. |
| Hushfacebook settings | Tested | The settings panel, opened from the corner button or your userscript manager's menu. |
| Following feed on Home | Tested | Opens Home on Facebook's most recent feed, from everyone you follow or just friends, favorites, groups or Pages. |
| Hide sponsored profile posts | Planned | Same feed cleanup, applied to profile and Page timelines. |
| Hide sponsored reels | Written | Drops the ad breaks Facebook schedules inside videos and reels. Every video the test account opened came with an empty list, so it hasn't had one to drop yet. Ads between reels need a capture first. |
| Hide sponsored stories | Planned | Ad cards in the story viewer. |
| Hide sponsored search results | Tested | Takes the ad results out of search before Facebook draws them. |
| Hide sponsored Marketplace listings | Tested | Takes ad cards out of the Marketplace feed before Facebook draws them, and the listings around them stay put. |
| Hide suggested and promoted posts | Planned | Suggested for you, People you may know, suggested groups and Pages. |
| Hide suggested stories | Planned | Stories from people and Pages you don't follow. |
| Hide Reels in the feed | Planned | Reel rows between posts. |
| Hide Stories tray | Planned | The stories row and the "What's on your mind?" box at the top of Home. |
| Hide post prompts | Planned | "Are you interested in this post?" strips and follow suggestions on posts. |
| Hide affiliate product links | Planned | Shopping cards on reels, posts and comments. |
| Hide AI-detected posts | Planned | Posts marked as made with AI, Meta AI characters and Meta AI cards. |
| Hide Meta AI in search | Planned | The Meta AI answer and Ask Meta AI prompts in search. |
| Hide Meta AI questions under posts | Planned | The row of Meta AI questions under posts. |
| Hide Meta AI comment summaries | Planned | Meta AI's comment summary. |
| Hide Meta upsells | Planned | Meta Verified, Threads cross-posting and other pitches. |
| Hide Menu promotions | Planned | Promotions in Facebook's left column and Menu. |
| Hide posts by words | Planned | Hide posts by words, people, Pages or sites you list. |
| Hide seen posts | Planned | Keeps posts you've already scrolled past out of the feed for a while. |
| Open on a chosen tab | Planned | Opens Facebook on the page you pick. |
| Marketplace only | Planned | Strips Facebook down to Marketplace. |
| Default comment order | Planned | Opens comments in the order you choose. |
| Comment sheet options | Planned | Show every reply, hide the GIF and sticker buttons, hide Related groups. |
| Download any photo | Planned | Save the largest copy of any photo. |
| Download any video | Planned | Download button for feed and Watch videos. |
| Download any reel | Planned | Download button for reels. |
| Download any story | Planned | Save stories, including ones with music. |
| Hide read receipts | Planned | Facebook's web chats send read receipts over a live connection, which the script can filter. End-to-end encrypted chats can't be changed. |
| Hide typing indicator | Planned | Same connection as read receipts. |
| Stop Story auto-advance | Planned | Keeps each story up until you move on. |
| Keep the reel speed | Planned | Remembers the speed you picked. |
| Hold a reel for 2x | Planned | Hold the mouse on a reel to play it at double speed. |
| Resume long videos | Planned | Picks long videos up where you left off. |
| Keep the progress bar | Planned | Keeps video controls and the progress bar on screen. |
| Picture-in-picture | Planned | A picture-in-picture button on videos and reels. |
| Turn off double tap to like | Planned | Stops a double click on a reel or video from liking it. |
| Clean up Reels | Planned | Hides Follow buttons, comment previews and other clutter on reels. |
| Hide reel interest prompts | Planned | "Are you interested in this reel?" |
| Hide the Reels tab | Planned | The Video tab in the top bar. |
| Hide the Reels tab dot | Planned | The count on the Video tab. |
| Hide tabs | Planned | Tabs you don't use in the top bar. |
| Hide tab badges | Planned | Counts on the top bar, and the count in the browser tab's title. |
| Hide the Feeds header | Planned | The filter row at the top of Feeds. |
| Clean up Facebook's chat list | Planned | The notes row and promo banners in Chats. |
| Block promotional notifications | Planned | Hides the kinds of notification you pick. |
| Force dark mode | Planned | Keeps Facebook's dark mode on. |
| AMOLED black theme | Planned | A pure black version of Facebook's dark mode. |
| Accent color | Planned | Your own color in place of Facebook's blue. |
| Use the system font | Planned | Your own font in place of Facebook's. |
| Use the phone's emoji | Planned | Your system's emoji in place of Facebook's emoji images. |
| Turn off screen transitions | Planned | Turns off Facebook's page animations. |
| Hushfacebook in the Menu | Planned | A HushFacebook Web row in Facebook's account menu. |
| Show View profile on Marketplace sellers | Planned | A link from a seller to their profile. |
| Share sheet items | Planned | Hide share menu items you never use. |
| Open Messenger from the top bar | Planned | Opens the full Messages page instead of the small chat popup. |
| Keep post dates | Needs research | The web shows relative times. A full date on every post is likely doable. |
| Turn off auto-translation | Needs research | Showing the original text by default. |
| Default playback quality | Needs research | Picking a quality in the web player. |
| Don't send reel watch history | Needs research | Finding the request that reports watched reels. |
| Block ad telemetry | Needs research | What blocking Facebook's logging calls breaks. |
| Hold back analytics uploads | Needs research | Same question for usage reports. |
| Block background ad prefetch | Needs research | Whether the web app fetches ads ahead of time. |
| Block background-return feed refresh | Needs research | Whether the web feed resets when you come back to the tab. |
| Block Instant Games ads | Needs research | Games run in their own frame on the web. |
| Tag suggestions only after @ | Needs research | How the web composer offers tags. |
| Send chat photos and videos at original quality | Needs research | How the web chat shrinks uploads. |
| Hide the Get Messenger card | Needs research | Whether the web shows this card at all. |
| Allow screenshots | Android only | Browsers don't block screenshots. |
| Block screenshot detection | Android only | Websites can't see screenshots. |
| Disable Audience Network | Android only | It's about ads inside other phone apps. |
| Disable Play Store updates | Android only | Browsers don't install Facebook. |
| Stop update prompts | Android only | There's no app to update. |
| Install beside Meta's apps | Android only | About Android app signatures. |
| Restore screens on re-signed builds | Android only | About Android app signatures. |
| Start on x86 devices | Android only | About the app's native code. |
| Material You theme | Android only | Android wallpaper colors. Accent color covers the web. |
| Tab bar at the bottom | Android only | The web layout has no bottom tab bar. |
| Turn off haptics | Android only | Browsers don't vibrate on Facebook. |
| Unlock app icons | Android only | Home screen icons. |
