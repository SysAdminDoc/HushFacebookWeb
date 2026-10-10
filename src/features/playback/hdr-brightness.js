// CSS dynamic-range-limit caps HDR media at standard range, so the screen doesn't jump to
// full brightness. Browsers without the property ignore the rule.

export default {
  id: 'limitHdr',
  section: 'playback',
  android: 'Turn off HDR brightness',
  title: 'Turn off HDR brightness',
  description: 'Stops HDR videos and photos from turning your screen up to full brightness. They keep their resolution.',
  default: false,
  css: 'video, img, canvas { dynamic-range-limit: standard !important; }',
};
