import { mirrorGameSetting } from './frame.js';

export default {
  id: 'blockInstantGamesAds',
  section: 'meta',
  android: 'Block Instant Games ads',
  title: 'Block Instant Games ads',
  description: "Makes supported game ad requests answer that no ad is available. Some games protect their ad system and can't be filtered. Rewards that need an ad won't be earned. Games use the setting from the Facebook account you last opened or changed it in. Reload an open game after changing this. Not yet checked in a live game.",
  default: false,

  setup({ storage, settings, enabled, log, markUnavailable }) {
    if (!mirrorGameSetting({ storage, settings, enabled, log })) {
      markUnavailable?.();
      log?.warn('Instant Games ad blocking needs storage from your userscript manager.');
    }
  },
};
