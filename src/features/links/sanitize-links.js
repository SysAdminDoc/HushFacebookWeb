import { cleanCopiedText, cleanUrl } from '../../core/url.js';
import { onLinkActivation } from './link-events.js';

export default {
  id: 'sanitizeLinks',
  section: 'links',
  android: 'Sanitize sharing links',
  title: 'Sanitize sharing links',
  description: "Takes Facebook's tracking tags off links you open or copy, so you share a clean link.",
  default: true,

  setup({ win, enabled }) {
    onLinkActivation(win, (anchor) => {
      if (!enabled()) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const cleaned = cleanUrl(href, { unwrap: false, base: win.location.href });
      if (cleaned !== href && cleaned !== anchor.href) anchor.setAttribute('href', cleaned);
    });

    // Facebook's "Copy link" goes through the async clipboard API.
    const clipboard = win.navigator.clipboard;
    const writeText = clipboard?.writeText;
    if (typeof writeText !== 'function') return;
    clipboard.writeText = function (text) {
      return writeText.call(this, enabled() ? cleanCopiedText(text) : text);
    };
  },
};
