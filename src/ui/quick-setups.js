import { KEPT_ON_RESET } from '../core/settings.js';

export const QUICK_SETUPS = Object.freeze([
  Object.freeze({
    id: 'quiet',
    label: 'Quiet',
    description: "Hides ads, suggested posts, Reels in the feed, red badges and Facebook's pitches for its other apps.",
    keys: Object.freeze([
      'hideSponsoredPosts',
      'hideSuggestedPosts',
      'hideReelsInFeed',
      'hideStoriesTray',
      'hideAiPosts',
      'hideFollowButtons',
      'hideSponsoredReels',
      'cleanUpReels',
      'hideSponsoredSearch',
      'hideSponsoredMarketplace',
      'hideNotificationKinds',
      'hideCommentStickers',
      'hideTabs',
      'hideTabBadges',
      'hideMenuPromotions',
      'hideMetaUpsells',
      'hidePromotions',
    ]),
  }),
  Object.freeze({
    id: 'privacy',
    label: 'Privacy',
    description: 'Keeps what you watch, search, read and type to yourself, and strips tracking from links.',
    keys: Object.freeze([
      'noWatchHistory',
      'noSearchHistory',
      'anonymousStories',
      'hideReadReceipts',
      'hideTyping',
      'hideCommentTyping',
      'tagsAfterAt',
      'holdBackLogs',
      'blockAdTelemetry',
      'sanitizeLinks',
      'directLinks',
    ]),
  }),
  Object.freeze({ id: 'defaults', label: 'Back to defaults', description: 'Puts every setting back the way it came, with Undo in case you change your mind.', reset: true }),
]);

export function applyQuickSetup(settings, id) {
  const setup = QUICK_SETUPS.find((entry) => entry.id === id);
  if (!setup) throw new Error(`Unknown Quick setup: ${id}`);
  const afterSave = (saved, changed) => saved && typeof saved.then === 'function' ? saved.then(() => changed) : changed;

  if (setup.reset) {
    const changed = [...settings.schema].filter(([key, spec]) => !KEPT_ON_RESET.includes(key) && (
      settings.get(key) !== spec.default || (settings.display?.(key) ?? settings.get(key)) !== spec.default
    )).length;
    const pending = settings.saveStatus?.().pending.length ?? 0;
    return changed || pending ? afterSave(settings.reset(), changed) : 0;
  }

  for (const key of setup.keys) {
    if (settings.schema.get(key)?.type !== 'toggle') throw new Error(`Quick setup has an unknown switch: ${key}`);
  }
  const changed = setup.keys.filter((key) => settings.get(key) !== true || (settings.display?.(key) ?? settings.get(key)) !== true);
  if (!changed.length) return 0;
  return afterSave(settings.setMany(Object.fromEntries(changed.map((key) => [key, true]))), changed.length);
}
