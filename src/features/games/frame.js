import { keepsSettings } from '../../core/storage.js';
import { installInstantGamesHooks } from './sdk.js';

export const GAME_ADS_KEY = 'instantGamesAds.enabled';
export const GAME_ADS_FEATURE = 'blockInstantGamesAds';
const RUNNING = Symbol.for('hushfacebook-web.games');

// Game frames never start Facebook's router, page hooks or settings panel.
export function executionTarget(win) {
  const { protocol, hostname } = win.location;
  if (protocol !== 'https:') return 'skip';
  if (hostname === 'apps.fbsbx.com' || hostname.endsWith('.apps.fbsbx.com')) return 'game';
  if ((hostname === 'www.facebook.com' || hostname === 'web.facebook.com') && win.top === win) return 'facebook';
  return 'skip';
}

// Facebook account cookies aren't available to a game. Only this boolean is shared.
export function mirrorGameSetting({ storage, settings, enabled, log }) {
  if (!keepsSettings(storage)) return null;
  const sync = () => {
    const next = enabled() === true;
    try {
      if (storage.get(GAME_ADS_KEY, undefined) === next) return;
      storage.set(GAME_ADS_KEY, next);
    } catch (error) {
      log?.error('Could not update the Instant Games ad setting', error);
    }
  };
  if (settings.whenLoaded) settings.whenLoaded(sync);
  else sync();
  const unsubscribe = settings.subscribe(({ keys }) => {
    if (keys.includes(GAME_ADS_FEATURE) || keys.includes('paused')) sync();
  });
  return { sync, stop: () => unsubscribe() };
}

export function startGameFrame({ win, storage, log, onBlocked }) {
  if (!keepsSettings(storage)) {
    log?.warn('Instant Games ad blocking needs storage from your userscript manager.');
    return null;
  }
  if (win[RUNNING]) return win[RUNNING];
  let stopped = false;
  let block = false;
  try {
    block = storage.get(GAME_ADS_KEY, false) === true;
  } catch (error) {
    log?.error('Could not read the Instant Games ad setting', error);
  }
  const hooks = installInstantGamesHooks({ win, enabled: () => !stopped && block, log, onBlocked });
  let unsubscribe;
  try {
    unsubscribe = storage.onChange?.(GAME_ADS_KEY, (value) => {
      if (stopped) return;
      block = value === true;
      hooks.refresh();
    });
  } catch (error) {
    block = false;
    log?.error('Could not follow the Instant Games ad setting; ads were left under game control', error);
  }
  const controller = {
    stop() {
      if (stopped) return;
      stopped = true;
      try { unsubscribe?.(); }
      catch (error) { log?.error('Could not stop following the Instant Games ad setting', error); }
      hooks.stop();
      if (win[RUNNING] === controller) delete win[RUNNING];
    },
  };
  win[RUNNING] = controller;
  return controller;
}
