// Hold back usage logs, Android's "Hold back analytics uploads". Facebook's site gathers what
// you do on the page (what was on screen and for how long, what you clicked) into batches and
// posts them to /ajax/bnzai, its logging endpoint, Banzai, by XHR or, as a page closes, with
// sendBeacon. Live 2026-10-11 (run 46): a multipart POST, answered with
//   for (;;);{"__ar":1,"rid":"...","payload":null,"lid":"..."}
// With this on, those posts never leave the page, and the page gets that same empty answer, so
// Banzai counts each batch as sent and doesn't keep it to send again.
//
// The site also reports how long you're on it, with one GraphQL mutation,
// FBScreenTimeLogger_syncMutation, sent as the page is hidden (live 2026-10-22 on Home, Marketplace
// and with Force dark mode: its input is your account, the time it was sent and your time zone, the
// start and end of each stretch you had the page open, and seconds today and in the last 24 hours).
// Facebook answers {"data":{},"errors":[]}, and that's what the page gets instead. It feeds
// Facebook's own count of your time on Facebook, which then leaves out this browser.
// useCIXLogMutation stays: it reports that a post's menu loaded its Report entry
// (frx_menu_item_loaded), and holding back part of the report flow can't be checked without
// reporting something.

import { EMPTY_SUCCESS } from '../reels/no-watch-history.js';

export const LOG_PATHS = new Set(['/ajax/bnzai']);
export const LOG_MUTATIONS = new Set(['FBScreenTimeLogger_syncMutation']);
export const EMPTY_ANSWER = 'for (;;);{"__ar":1,"payload":null}';

const facebookHost = (host) => host === 'facebook.com' || host.endsWith('.facebook.com');
const isTimeReport = (ctx) => LOG_MUTATIONS.has(ctx.friendlyName);

export const isUsageLog = (ctx) => facebookHost(ctx.host ?? '') && (LOG_PATHS.has(ctx.path) || isTimeReport(ctx));

export default {
  id: 'holdBackLogs',
  section: 'privacy',
  android: 'Hold back analytics uploads',
  title: 'Hold back usage logs',
  description: "Facebook's site keeps a log of what you look at and click, and sends it in batches as you go, along with how long you've been on the site. With this on, neither leaves your browser, so Facebook's count of your time on Facebook won't take in time spent in this browser. Nothing else is held back.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    let times = 0;
    net.blockRequests({
      id: 'holdBackLogs',
      startupPrivacy: true,
      enabled,
      match: isUsageLog,
      fakeResponse: (ctx) => {
        diagnostics?.changed();
        if (isTimeReport(ctx)) {
          times++;
          return EMPTY_SUCCESS;
        }
        held++;
        return EMPTY_ANSWER;
      },
    });
    diagnostics?.add('Usage log batches held back', () => String(held));
    diagnostics?.add('Time on site reports held back', () => String(times));
  },
};
