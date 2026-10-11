import { cleanCopiedText, cleanUrl } from '../../core/url.js';
import { onLinkActivation } from './link-events.js';

// Copy link first asks Facebook to mint a facebook.com/share/p/<token>/ link, which is tied to
// whoever shared it and can't be cleaned afterwards. Held back with an empty success,
// Facebook copies the post's own address instead (seen live 2026-10-10).
export const SHARE_LINK_MUTATIONS = new Set(['useLinkSharingCreateWrappedUrlMutation']);

export default {
  id: 'sanitizeLinks',
  section: 'links',
  android: 'Sanitize sharing links',
  title: 'Sanitize sharing links',
  description: "Takes Facebook's tracking tags off links you open or copy. Copy link gives the post's own address instead of a share link that leads back to you.",
  default: true,

  setup({ win, net, enabled }) {
    net?.blockRequests({
      id: 'sanitizeLinks',
      enabled,
      match: (ctx) => SHARE_LINK_MUTATIONS.has(ctx.friendlyName),
      fakeResponse: () => '{"data":{},"errors":[]}',
    });

    onLinkActivation(win, (anchor) => {
      if (!enabled()) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const cleaned = cleanUrl(href, { unwrap: false, base: win.location.href });
      if (cleaned !== href && cleaned !== anchor.href) anchor.setAttribute('href', cleaned);
    });

    // Copies made through the async clipboard API. Facebook's own Copy link doesn't use it
    // (2026-10-10), so the share link block above is what cleans that one.
    const clipboard = win.navigator.clipboard;
    const writeText = clipboard?.writeText;
    if (typeof writeText !== 'function') return;
    clipboard.writeText = function (text) {
      return writeText.call(this, enabled() ? cleanCopiedText(text) : text);
    };
  },
};
