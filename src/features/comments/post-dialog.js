// A post opened from its link shows in a dialog over Home, and the feed's copy of it behind
// the dialog has comments of its own (seen live 2026-10-11). While any dialog with something
// in it is open, the comment features leave the page behind it alone. That covers the moment
// the dialog is up but its comments haven't drawn yet, when only its Close button is there.

export function dialogOpen(doc) {
  return Boolean(doc.querySelector('[role="dialog"] [role="button"], [role="dialog"] [role="article"]'));
}
