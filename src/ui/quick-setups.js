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

  if (setup.reset) {
    const changed = [...settings.schema].filter(([key, spec]) => settings.get(key) !== spec.default).length;
    if (changed) settings.reset();
    return changed;
  }

  for (const key of setup.keys) {
    if (settings.schema.get(key)?.type !== 'toggle') throw new Error(`Quick setup has an unknown switch: ${key}`);
  }
  const changed = setup.keys.filter((key) => settings.get(key) !== true);
  if (!changed.length) return 0;
  const next = settings.snapshot();
  for (const key of changed) next[key] = true;
  settings.restore(next);
  return changed.length;
}
