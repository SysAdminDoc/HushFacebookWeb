// Where each setting sits in the panel. The sidebar lists the pages, each page shows its groups in
// this order, and a group shows its features in the feature list's order. A feature's section is
// one of the group ids. Pages follow what a person wants done (ads gone, video under control),
// not where on Facebook it happens, so every ad switch shares a page whichever surface it's on.
export const PAGES = [
  { id: 'ads', title: 'Ads and promotions', description: 'Ads come out everywhere Facebook shows them, along with its pitches for its own apps.' },
  { id: 'feed', title: 'Feed', description: 'Choose what makes it into Home and your groups feed.' },
  { id: 'video', title: 'Video', description: 'Reels, Watch, stories and every video in between.' },
  { id: 'comments', title: 'Comments', description: 'Read the conversation your way.' },
  { id: 'privacy', title: 'Privacy', description: 'Choose what Facebook, and the people you talk to, get to know.' },
  { id: 'downloads', title: 'Downloads', description: 'Save the moments you want to keep.' },
  { id: 'appearance', title: 'Appearance', description: 'Make Facebook feel like yours.' },
  { id: 'more', title: 'Around Facebook', description: 'Where Facebook opens, plus Marketplace, notifications and menus.' },
];

export const SECTIONS = [
  { id: 'ads', page: 'ads', title: 'Ads' },
  { id: 'promotions', page: 'ads', title: "Facebook's own promotions" },
  { id: 'feed', page: 'feed', title: 'Take out of the feed' },
  { id: 'filters', page: 'feed', title: 'Your filters' },
  { id: 'reading', page: 'feed', title: 'While you read' },
  { id: 'playback', page: 'video', title: 'Playing' },
  { id: 'controls', page: 'video', title: 'Controls' },
  { id: 'reels', page: 'video', title: 'Reels and stories' },
  { id: 'watched', page: 'video', title: 'After you watch' },
  { id: 'comments', page: 'comments', title: 'Comments' },
  { id: 'people', page: 'privacy', title: 'What people see' },
  { id: 'privacy', page: 'privacy', title: 'What Facebook learns' },
  { id: 'links', page: 'privacy', title: 'Links' },
  { id: 'downloads', page: 'downloads', title: 'Downloads' },
  { id: 'appearance', page: 'appearance', title: 'Colors and theme' },
  { id: 'text', page: 'appearance', title: 'Text and motion' },
  { id: 'layout', page: 'appearance', title: 'Layout' },
  { id: 'tools', page: 'appearance', title: 'Tools' },
  { id: 'opening', page: 'more', title: 'When Facebook opens' },
  { id: 'marketplace', page: 'more', title: 'Marketplace' },
  { id: 'notifications', page: 'more', title: 'Notifications' },
  { id: 'menu', page: 'more', title: 'Menus' },
];
