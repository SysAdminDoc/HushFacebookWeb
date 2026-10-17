// Hold back usage logs, Android's "Hold back analytics uploads". Facebook's site gathers what
// you do on the page (what was on screen and for how long, what you clicked) into batches and
// posts them to /ajax/bnzai, its logging endpoint, Banzai, by XHR or, as a page closes, with
// sendBeacon. Live 2026-10-11 (run 46): a multipart POST, answered with
//   for (;;);{"__ar":1,"rid":"...","payload":null,"lid":"..."}
// With this on, those posts never leave the page, and the page gets that same empty answer, so
// Banzai counts each batch as sent and doesn't keep it to send again.

export const LOG_PATHS = new Set(['/ajax/bnzai']);
export const EMPTY_ANSWER = 'for (;;);{"__ar":1,"payload":null}';

const facebookHost = (host) => host === 'facebook.com' || host.endsWith('.facebook.com');

export const isUsageLog = (ctx) => facebookHost(ctx.host ?? '') && LOG_PATHS.has(ctx.path);

export default {
  id: 'holdBackLogs',
  section: 'privacy',
  android: 'Hold back analytics uploads',
  title: 'Hold back usage logs',
  description: "Facebook's site keeps a log of what you look at and click, and sends it in batches as you go. With this on, those batches never leave your browser. Nothing else is held back.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    net.blockRequests({
      id: 'holdBackLogs',
      startupPrivacy: true,
      enabled,
      match: isUsageLog,
      fakeResponse: () => {
        held++;
        diagnostics?.changed();
        return EMPTY_ANSWER;
      },
    });
    diagnostics?.add('Usage log batches held back', () => String(held));
  },
};
