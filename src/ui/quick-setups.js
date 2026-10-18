import { KEPT_ON_RESET } from '../core/settings.js';

export const QUICK_SETUPS = Object.freeze([
  Object.freeze({
    id: 'quiet',
    label: 'Quiet',
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
    keys: Object.freeze([
      'noWatchHistory',
      'anonymousStories',
      'hideReadReceipts',
      'hideTyping',
      'hideCommentTyping',
      'tagsAfterAt',
      'holdBackLogs',
      'sanitizeLinks',
      'directLinks',
    ]),
  }),
  Object.freeze({ id: 'defaults', label: 'Back to defaults', reset: true }),
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
