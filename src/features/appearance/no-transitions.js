// Turn off screen transitions, as on Android. Every CSS transition and animation finishes at
// once. They get a near-zero length rather than none, so the transitionend and animationend
// events Facebook waits on still fire. Looping animations run once and stop, except inside a
// progress bar, so a spinner still shows something is loading.

export const ANIMATED = '*:not([role="progressbar"], [role="progressbar"] *)';

export const NO_TRANSITIONS_CSS = `${ANIMATED}, ${ANIMATED}::before, ${ANIMATED}::after {
  transition-duration: 0.001ms !important;
  transition-delay: 0s !important;
  animation-duration: 0.001ms !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
}
html { scroll-behavior: auto !important; }`;

export default {
  id: 'noTransitions',
  section: 'appearance',
  android: 'Turn off screen transitions',
  title: 'Turn off screen transitions',
  description: "Menus, dialogs and pages appear at once, without Facebook's fades and slides. Loading spinners keep turning.",
  default: false,
  css: NO_TRANSITIONS_CSS,
};
