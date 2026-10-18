// Every happy-dom page the tests use is made here, so none of them reaches a server on its own.
// Facebook markup is full of facebook.com and fbcdn.net addresses, and a fixture should never
// make the test machine fetch them. This is about keeping the tests to themselves. The userscript
// and the extension never run in happy-dom.
//
// Off: stylesheets (including @import), iframe pages, images, script files, every kind of
// navigation (a change of address just sets it), and any fetch or XHR the page makes, which gets
// an error answer (status 0) instead. A test that needs one of these on passes it in `settings`,
// which takes happy-dom's own setting names and wins over these.
import { Window } from 'happy-dom';

const refused = ({ window }) => window.Response.error();
const refusedSync = ({ request, window }) => ({
  status: 0, statusText: '', ok: false, url: request.url, redirected: false, headers: new window.Headers(), body: null,
});

export const OFFLINE_SETTINGS = Object.freeze({
  enableCSSFileLoading: false,
  enableIframePageLoading: false,
  enableImageFileLoading: false,
  disableJavaScriptFileLoading: true,
  navigation: Object.freeze({ disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true }),
  fetch: Object.freeze({ interceptor: Object.freeze({ beforeAsyncRequest: async (context) => refused(context), beforeSyncRequest: refusedSync }) }),
});

export function testWindow(url, settings = {}) {
  return new Window({
    url,
    settings: {
      ...OFFLINE_SETTINGS,
      ...settings,
      navigation: { ...OFFLINE_SETTINGS.navigation, ...settings.navigation },
      fetch: { ...OFFLINE_SETTINGS.fetch, ...settings.fetch },
    },
  });
}
