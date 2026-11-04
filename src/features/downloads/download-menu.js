// Hushfacebook's Download first in post menus on Android puts Download to phone and Save photo at
// the top of a post's three-dot menu (2026-10-18), since the row under a post has no room for a
// button. On the web the Download button only shows on hover or Tab, so this puts a Download row
// at the top of the menu instead, saving what the button would. How the menu is found and the row
// drawn is in core/dom/post-menu.js. A post with no photo or video that a Download switch that's on
// covers gets no row, like Android's.

import { whenBodyReady } from '../../core/env.js';
import { OPENER, POST, buildMenuRow, createPostMenuRow } from '../../core/dom/post-menu.js';
import { isComment } from '../../core/dom/posts.js';
import { t } from '../../core/i18n.js';
import { DOWNLOAD_ICON } from './button.js';
import { downloads } from './shared.js';

export const ROW_MARK = 'data-hfw-menu-download';

// The post's first photo or video that find() can save, leaving out comments and posts inside it.
export function mediaOf(post, find) {
  for (const media of post.querySelectorAll('video, img')) {
    if (media.closest(POST) !== post) continue;
    const found = find(media);
    if (found) return { media, found };
  }
  return null;
}

// The post whose own three-dot button has its menu open, when it has something to save, or null.
// The post's button sits in its header above the photo or video. Its other buttons that open a
// menu, comment order and the comment box's emoji, GIF and sticker buttons, come after it.
export function openPost(doc, find) {
  const following = (doc.defaultView?.Node ?? globalThis.Node).DOCUMENT_POSITION_FOLLOWING;
  for (const button of doc.querySelectorAll(OPENER)) {
    const post = button.closest(POST);
    if (!post || isComment(post)) continue;
    const pick = mediaOf(post, find);
    if (pick && button.compareDocumentPosition(pick.media) & following) return post;
  }
  return null;
}

// A copy of one of the menu's rows that reads Download with a download picture, or null when the
// row has no words to replace.
export const buildRow = (template, doc) => buildMenuRow(template, doc, { text: t('Download'), icon: DOWNLOAD_ICON, mark: ROW_MARK });

// find(media) and run(found) are the Download button's own (shared.js), missing() says there's
// nothing to save any more.
export function createMenuDownload({ doc, enabled, find, run, missing, log, setTimer }) {
  let clicked = 0;
  const row = createPostMenuRow({
    doc, enabled, setTimer,
    mark: ROW_MARK,
    icon: DOWNLOAD_ICON,
    top: true,
    failed: (error) => log?.error("Couldn't add Download to the post menu", error),
    pick() {
      const post = openPost(doc, find);
      return post && { post };
    },
    label: () => t('Download'),
    run({ post }) {
      // Asked again, since the post may have changed while its menu was open.
      const pick = post.isConnected ? mediaOf(post, find) : null;
      if (!pick) {
        missing?.();
        return;
      }
      clicked++;
      Promise.resolve(run(pick.found, null)).catch((error) => log?.error('The download failed', error));
    },
  });
  return {
    apply: row.apply,
    sync: row.sync,
    state: () => ({ added: row.added(), clicked }),
  };
}

export default {
  id: 'downloadMenu',
  section: 'downloads',
  android: 'Download first in post menus',
  title: 'Download in post menus',
  description: "Puts Download at the top of a post's three-dot menu when the post has a photo or video to save. It saves the same file as the Download button, so it follows the switches above.",
  default: false,

  setup(ctx) {
    const { doc, settings, enabled, log, diagnostics } = ctx;
    if (!doc) return;
    const shared = downloads(ctx);
    const entry = createMenuDownload({ doc, enabled, find: shared.find, run: shared.run, missing: shared.missing, log });
    whenBodyReady(() => entry.apply(), doc);
    settings?.subscribe(() => entry.apply());
    diagnostics?.add('Post menu downloads', () => {
      const { added, clicked } = entry.state();
      return `Added to ${added} ${added === 1 ? 'menu' : 'menus'}, clicked ${clicked}`;
    });
  },
};
