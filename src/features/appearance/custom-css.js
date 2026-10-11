// Custom CSS: your own rules for Facebook. There's no Hushfacebook patch behind it, but
// F.B. Purity and Social Fixer both have one, and it's the quick fix when Facebook moves
// something a switch looks for. The rules go last into the script's own style element, so at
// the same specificity they win over everything the script does. Works in content mode.

export default {
  id: 'customCss',
  section: 'appearance',
  android: 'Custom CSS',
  title: 'Custom CSS',
  description: 'Your own CSS rules for Facebook, applied after everything else the script does. Handy when Facebook moves something before a switch catches up.',
  default: false,
  options: [
    { key: 'css', type: 'text', rows: 8, code: true, label: 'CSS rules', default: '', maxLength: 50000 },
  ],
  css: (get) => String(get('customCss.css') ?? ''),
};
