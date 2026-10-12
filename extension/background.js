// The extension's service worker: saves photos and videos with chrome.downloads, and opens the
// settings panel from the toolbar button. A classic script, so openSettings is a global the
// live check can call the way a click would.

const FACEBOOK = ['www.facebook.com', 'web.facebook.com'];
// Where the script's downloads come from: Facebook's media servers.
const SAVABLE = /(^|\.)(fbcdn\.net|facebook\.com)$/;
// The worker answers by then even when a large file is still coming, so it never outlives the
// browser's limit on one event. The download carries on either way.
const ANSWER_WITHIN = 20000;

function hostOf(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function savable(url) {
  const parsed = hostOf(url);
  return parsed?.protocol === 'https:' && SAVABLE.test(parsed.hostname);
}

async function save({ url, name }) {
  if (!savable(url)) throw new Error('that address is not a Facebook file');
  const id = await chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' });
  return new Promise((resolve, reject) => {
    const done = (error) => {
      chrome.downloads.onChanged.removeListener(watch);
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve();
    };
    const watch = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === 'complete') done();
      else if (delta.state?.current === 'interrupted') done(delta.error?.current ?? 'the download stopped');
    };
    const timer = setTimeout(() => done(), ANSWER_WITHIN);
    chrome.downloads.onChanged.addListener(watch);
  });
}

const tellTab = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'open-settings' }, { frameId: 0 });

// Opens the panel once the tab has finished loading.
function openWhenLoaded(tabId) {
  const loaded = (id, change) => {
    if (id !== tabId || change.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(loaded);
    tellTab(tabId).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(loaded);
}

// The toolbar button. On Facebook it opens the panel. A Facebook tab opened before the
// extension was there has no script yet, so it reloads first. Anywhere else, Facebook opens in
// a new tab with the panel up. activeTab lets the click see the tab's address.
async function openSettings(tab) {
  if (!FACEBOOK.includes(hostOf(tab.url)?.hostname)) {
    const opened = await chrome.tabs.create({ url: 'https://www.facebook.com/', index: tab.index + 1 });
    openWhenLoaded(opened.id);
    return 'new tab';
  }
  try {
    await tellTab(tab.id);
    return 'opened';
  } catch {
    openWhenLoaded(tab.id);
    await chrome.tabs.reload(tab.id);
    return 'reloaded';
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'download' || !sender.tab) return false;
  save(message).then(
    () => respond({ ok: true }),
    (error) => respond({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  openSettings(tab);
});
