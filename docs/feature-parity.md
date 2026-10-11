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
| Hide sponsored posts | Written | Removes ads from the feed data before Facebook draws it, including the first screen that comes inline with the page. An ad that still gets drawn is hidden on the page by its "Sponsored" or "Ad" label, read the way a person sees it (scrambled letters put back in order, hidden decoys skipped). That page check also runs in content mode, where the data layer can't. English labels only for now. In content mode the page check has been seen hiding both ads on a search page and leaving the other eight results alone (2026-10-11). The test account hasn't been shown a feed ad to watch either layer work there yet. |
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
| Hide suggested and promoted posts | Tested | Takes posts from Pages, people and groups you don't follow out of Home and your groups feed before Facebook draws them. Any that get drawn anyway, or every one in content mode, are hidden by the Follow or Join button after the author's name (English for now). Search, a Page's own posts and groups you browse are left alone. People you may know rows are next. |
| Hide suggested stories | Planned | Stories from people and Pages you don't follow. |
| Hide Reels in the feed | Written | Hides rows of reels between posts on Home, told apart by their links rather than their heading, so any language works. A reel a friend posts stays. The test account hasn't been shown a reel row yet. |
| Hide Stories tray | Tested | Takes the Stories row off the top of Home, and the "What's on your mind?" box too unless you keep it. The posts move up into the space. Both are found without reading any English, so it works in other languages and in content mode. |
| Hide post prompts | Planned | "Are you interested in this post?" strips and follow suggestions on posts. |
| Hide affiliate product links | Planned | Shopping cards on reels, posts and comments. |
| Hide AI-detected posts | Tested | Posts Facebook labels as made with AI, and shares of them, come out of Home, the groups feed and search results before they're drawn, going by the AI info label in Facebook's data. A post opened from its link and profiles are left alone. Page mode only. Meta AI characters and Meta AI cards haven't turned up on the web yet. |
| Hide Meta AI in search | Planned | The Meta AI answer and Ask Meta AI prompts in search. The test account hasn't been shown either on the web yet, in search suggestions or results. |
| Hide Meta AI questions under posts | Planned | The row of Meta AI questions under posts. Not shown to the test account on the web yet. |
| Hide Meta AI comment summaries | Planned | Meta AI's comment summary. Not shown to the test account on the web yet, even under a post with over a thousand comments. |
| Hide Meta upsells | Tested | Takes Meta's other apps and devices out of the left column and Facebook's menu: Meta AI, Meta Quest, Ray-Ban Meta, WhatsApp, Instagram and Messenger Kids. They're found by their links leaving Facebook, not by name, so it works in any language and in content mode. Meta Verified and Threads pitches haven't shown up on the web yet. |
| Hide Menu promotions | Tested | Takes Ads Manager, Your Ad Activity and the Create column's Ad out of the left column and Facebook's menu, and Gaming Video and Play games too, each group with its own choice. Found by address. Works in content mode. |
| Hide posts by words | Tested | Hides posts on Home and in your groups feed that mention a word or phrase you list, come from a person, Page or group you name, or link to a site you name. Lines starting with re: are patterns. Separate switches hide every photo, video or link post, and every post on a colored background. Comments don't count. Matching posts come out of Facebook's data before they're drawn. In content mode they're hidden on the page with a note saying which line matched, except colored backgrounds, which only the data shows. |
| Hide seen posts | Tested | Keeps posts you've already scrolled past on Home and in your groups feed away for 1, 3, 7 or 30 days. A post counts as seen after a second on screen. Facebook's page no longer says which post is which, so a post is recognized by its photo or video, or by its first words. Seen posts come out of Facebook's data before they're drawn, or get hidden on the page in content mode. The switch's card has buttons to show them again in the current tab or forget the list. |
| Open on a chosen tab | Tested | The first page of a visit in a new tab goes to Marketplace, Feeds (newest first, using Following feed's filter when that's on), Video, Friends, your groups feed, Notifications or the Menu instead of Home. A reload, Back, a later Home click and links into Facebook stay where they are. Works in content mode. |
| Marketplace only | Tested | Every Home load and click on the logo or Home goes to Marketplace, and the top bar's other tabs and Find friends are hidden. Other pages still open from their links. It takes Home ahead of Open on a chosen tab and Following feed on Home. Works in content mode. |
| Default comment order | Tested | Opens a post's comments as Newest or All comments instead of Most relevant, on its own page and when you open it from the feed. Facebook only changes the order through its own menu, so the script picks from that menu once per post, going by the titles Facebook uses in your language. Changing it by hand afterwards sticks. |
| Comment sheet options | Tested | Two switches on the web. Show every reply opens each "View 3 replies" button in an open post as it shows up. It knows the buttons by the curved arrow Facebook draws in front of them, so it doesn't depend on the words, and on two English posts the arrow picked out the same buttons the words did. Hide GIF and sticker buttons takes the avatar sticker, GIF and sticker buttons out of comment boxes on posts, told apart from emoji by the kind of icon they draw. Related groups never showed up in comments on the web, checked on two group posts and two Page posts. Both work in content mode. |
| Download any photo | Tested | A Download button shows on photos in posts and in the photo viewer when you point at one. It saves the largest copy Facebook sent, named after whoever posted it, with the file type the server really sends. In content mode it saves the copy on screen. |
| Download any video | Written | A Download button on feed and Watch videos that saves the file Facebook's data lists, HD unless you pick smaller files. A video Facebook only streams in small pieces gets a message saying so. The test account's feed and Watch have only offered reels so far, so a plain video hasn't been saved live yet. Page mode only. |
| Download any reel | Tested | A Download button on reels in the feed and in the reels viewer, saving the HD file when there is one. Page mode only. |
| Download any story | Tested | A Download button on the story you're watching, named after whose story it is. A video story saved live. Photo stories pass the tests on a captured story but haven't been tried live, and stories with music haven't turned up yet. Page mode only. |
| Hide read receipts | Written | Takes the task that marks a chat read out of what Facebook's chat connection sends, and the rest of that request goes as it was. Live, the script saw every message the chat connection sent and chat kept working with the switch on, but the test account's chats are all end-to-end encrypted, which this can't reach, so it hasn't had a receipt to hold back yet. Page mode only. |
| Hide typing indicator | Written | Sends "not typing" where Facebook would say you're typing, on the same connection. Like read receipts, it doesn't reach end-to-end encrypted chats and hasn't been seen at work live yet. Page mode only. |
| Stop Story auto-advance | Tested | Called "Stop stories moving on" on the web. The viewer's progress follows the story's video, so the script pauses a video story just before it ends and the card stays until you click the arrow. Pausing and playing it again lets it finish and move on. Its card can play the story again instead. Photo stories run on a timer the page doesn't show, so they still move on. Works in content mode. |
| Keep the reel speed | Tested | Called "Keep your video speed" on the web, and it covers every video. Facebook gives each new video and reel normal speed, so the script remembers the speed you pick in a video's Settings menu and gives it to each one as it starts, even after a reload. Live, 1.5 picked on a Page video carried to the next video, the next reel and a feed video. Stories keep their own pace. Works in content mode. |
| Hold a reel for 2x | Tested | Hold the mouse down on a reel and it plays at double speed until you let go. The click that ends the hold doesn't reach Facebook, so the reel keeps playing, and a quick click still pauses it. Works in content mode. |
| Resume long videos | Tested | A long video you stopped partway through starts where you left it, three seconds early. Live, a Page video stopped at 2:22 picked up at 2:19 after a reload. You pick how long counts as long, from 2 to 20 minutes, and reels and stories aren't kept. Works in content mode. |
| Keep the progress bar | Tested | Called "Keep video controls on screen" on the web. A feed, Page or Watch video's controls fade out when the pointer leaves, and the script keeps them showing. It finds them by the progress bar whose length matches the video's, so any language works. Reels keep their controls already, and a reel shared to the feed has none. Works in content mode. |
| Picture-in-picture | Tested | Called "Picture-in-picture button" on the web. A Pop out button shows in the corner of a video or reel when you point at it, and it plays on in its own small window. Clicking it again brings it back. Works in content mode. |
| Turn off double tap to like | Android only | A double click on a reel doesn't like it on the web. Live, it sent nothing to Facebook and left the Like button as it was. |
| Clean up Reels | Planned | Hides Follow buttons, comment previews and other clutter on reels. |
| Hide reel interest prompts | Planned | "Are you interested in this reel?" |
| Hide the Reels tab | Written | Part of Hide tabs, where the Video tab is one of the choices and starts on. The test account's top bar only has Home, Friends and Groups, so the Video tab hasn't been seen going yet. |
| Hide the Reels tab dot | Written | Part of Hide tab badges. |
| Hide tabs | Tested | Takes the top bar tabs you pick off the page, with Video, Marketplace and Gaming on to start and Friends and Groups as choices, plus the Find friends button. Each tab is found by its address and its whole slot goes, so the others close up. Home always stays. Works in content mode. |
| Hide tab badges | Written | Takes the count off the front of the browser tab's title as soon as Facebook writes it, which has been seen working. Also hides the red counts on the top bar and the left column, found by being a floating or colored count rather than by class names. The test account hasn't had a count to show yet, so that part hasn't been seen on facebook.com. Works in content mode. |
| Hide the Feeds header | Planned | The filter row at the top of Feeds. |
| Clean up Facebook's chat list | Planned | The notes row and promo banners in Chats. |
| Block promotional notifications | Tested | Called "Hide kinds of notifications" on the web. Each notification's link names its kind, the same name Facebook's data uses, so the script sorts them into groups and hides the ones you pick: birthdays, memories, people you may know and Pages to follow to start, with friends' posts, group join approvals and reactions as choices. Any other kind can be listed by the name Diagnostics shows. Live, reactions and a friend suggestion were hidden on the Notifications page and in the bell's list, while a friend request, a group welcome, a friend's new photo and the section titles stayed. The test account hasn't had a birthday or memory notification, so those go by the words in their kind names. The red count on the bell still counts hidden ones. Works in content mode. |
| Force dark mode | Tested | Swaps the theme class Facebook puts on the page to its dark one and keeps it there, the same way Facebook switches itself. The pop-up layers that hold the account, Notifications, Messenger and post menus carry their own copy of the class, so they're swapped too. Switching it off brings back Facebook's own choice. Works in content mode. |
| AMOLED black theme | Tested | Sets dark mode's page, card, top bar and side column colors to pure black, and bubbles, text boxes and menus to near black. Dark mode only, so it goes with Facebook's dark mode or Force dark mode. Works in content mode. |
| Accent color | Tested | Seven colors or your own #RRGGBB for the accent, buttons, links, focus rings, switches and highlights, with Facebook's lighter and darker steps worked out for light and dark mode. Blue icons are tinted to the exact color by SVG filters in place of Facebook's filter chains. The logo, the Like reaction and the unseen story ring keep Facebook's colors. Works in content mode. |
| Use the system font | Tested | Points Facebook's four font variables, and the page's own font, at your system's interface font or at an installed font you name. Code keeps its monospace font. Works in content mode. |
| Use the phone's emoji | Tested | Called "Use your computer's emoji" on the web. Swaps the picture behind each of Facebook's emoji images for one drawn with your system's emoji font, keeping the image, its size and its alt text, so copying text still gives the emoji. Works in content mode. |
| Turn off screen transitions | Tested | Every CSS transition and animation finishes at once (a near-zero length, so Facebook's end events still fire), except inside progress bars. Works in content mode. |
| Hushfacebook in the Menu | Tested | Called "Settings in your account menu" on the web. A HushFacebook Web row just above Log out in the menu under your profile picture, copied from Facebook's own row so it matches both themes, and found by the menu's /me/ link rather than its words. Its card can hide the corner button. Works in content mode. |
| Show View profile on Marketplace sellers | Tested | A View profile link after the seller's name on a listing, opened on its own page or over Marketplace. The seller's Marketplace profile address carries their Facebook id, so the link goes to that profile. The name link is the one whose words match the seller picture's label, which skips Seller details and works in any language. Works in content mode. |
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

## Only on the web

These have no Hushfacebook patch behind them.

| Feature | Status | What it does |
|---|---|---|
| Custom CSS | Tested | Your own CSS rules, put last in the script's style so they win over its built-in rules. Text that looks like CSS in Hide posts by words gets a warning pointing here. Works in content mode. |
