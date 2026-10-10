import { cleanUrl, isOutbound, unshim } from '../../core/url.js';
import { onLinkActivation } from './link-events.js';

// Android's "Open links in external browser" sends links to your own browser instead of
// Facebook's in-app one. On the web the browser is already yours, so the matching job is
// skipping the l.facebook.com hop that records the click.
export default {
  id: 'directLinks',
  section: 'links',
  android: 'Open links in external browser',
  title: "Skip Facebook's link redirect",
  description: "Opens outside links directly instead of through l.facebook.com, so Facebook doesn't record the click.",
  default: true,

  setup({ win, enabled }) {
    onLinkActivation(win, (anchor) => {
      if (!enabled()) return undefined;
      const href = anchor.getAttribute('href');
      const target = href && unshim(href, win.location.href);
      if (target) anchor.setAttribute('href', cleanUrl(target));
      return isOutbound(anchor.href) ? 'stop' : undefined;
    });
  },
};
