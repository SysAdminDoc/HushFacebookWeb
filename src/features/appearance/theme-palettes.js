// The Calm theme's palettes, each with a light and a dark side. Roles:
//   page     behind everything: the feed's gutters and the side columns
//   card     posts, the top bar and the composer
//   flat     comment bubbles, link previews and flat cards that sit on a card
//   popover  menus, toasts and floating buttons
//   input    text boxes, inputOff a box you can't type in
//   text     what people wrote and the main labels, muted the secondary labels and placeholders,
//            faint for what's switched off
//   line     dividers, reply threads and the edges of text boxes
//   accent   buttons, links and switches, shaded per surface by accent.js's palette()
//   red, green  errors and confirmations in Facebook's text
// On every surface of its side the main text reads at 6:1 or more and muted text at 4.5:1
// (tests/calm-theme.test.js). Faint is for switched-off controls, which have no minimum.
// Catppuccin (catppuccin.com) and Nord (nordtheme.com) are MIT licensed palettes, notices in
// THIRD_PARTY_NOTICES.txt. Their reds and greens are darkened or lightened where the original
// didn't reach 4.5:1 as text.
export const THEMES = [
  {
    value: 'soft',
    label: 'Soft',
    light: {
      page: '#ECEEF1', card: '#FAFBFC', flat: '#EFF1F4', popover: '#FFFFFF', input: '#FFFFFF', inputOff: '#EFF1F4',
      text: '#1D2127', muted: '#59606A', faint: '#9AA0A9', line: '#DCDFE4', accent: '#2F6BD8', red: '#C62D3A', green: '#2A7D34',
    },
    dark: {
      page: '#121418', card: '#1F2227', flat: '#292D33', popover: '#2B2F35', input: '#1B1E22', inputOff: '#141619',
      text: '#DEE2E8', muted: '#A3AAB5', faint: '#6D7480', line: '#343941', accent: '#2F6BD8', red: '#F07C76', green: '#5CC26A',
    },
  },
  {
    value: 'catppuccin',
    label: 'Catppuccin',
    light: {
      page: '#DCE0E8', card: '#EFF1F5', flat: '#E6E9EF', popover: '#EFF1F5', input: '#EFF1F5', inputOff: '#E6E9EF',
      text: '#4C4F69', muted: '#5C5F77', faint: '#9CA0B0', line: '#CCD0DA', accent: '#1E66F5', red: '#C40D35', green: '#2A721C',
    },
    dark: {
      page: '#11111B', card: '#1E1E2E', flat: '#313244', popover: '#313244', input: '#181825', inputOff: '#11111B',
      text: '#CDD6F4', muted: '#A6ADC8', faint: '#6C7086', line: '#45475A', accent: '#89B4FA', red: '#F38BA8', green: '#A6E3A1',
    },
  },
  {
    value: 'nord',
    label: 'Nord',
    light: {
      page: '#D8DEE9', card: '#ECEFF4', flat: '#E5E9F0', popover: '#ECEFF4', input: '#ECEFF4', inputOff: '#E5E9F0',
      text: '#2E3440', muted: '#4C566A', faint: '#8F9BB3', line: '#D0D6E1', accent: '#4C6A92', red: '#A6424C', green: '#446B2E',
    },
    dark: {
      page: '#242933', card: '#2E3440', flat: '#3B4252', popover: '#3B4252', input: '#2B303B', inputOff: '#242933',
      text: '#ECEFF4', muted: '#AEB6C4', faint: '#616E88', line: '#434C5E', accent: '#88C0D0', red: '#EBA0A7', green: '#A3BE8C',
    },
  },
  {
    value: 'paper',
    label: 'Paper',
    light: {
      page: '#EDE4D3', card: '#F8F2E6', flat: '#F0E7D8', popover: '#FBF7EF', input: '#FBF7EF', inputOff: '#EDE4D3',
      text: '#3A3027', muted: '#6B5D4D', faint: '#A6977F', line: '#E2D6C2', accent: '#B0532A', red: '#B3261E', green: '#356A25',
    },
    dark: {
      page: '#12100D', card: '#221E1A', flat: '#2D2823', popover: '#302A24', input: '#1E1A17', inputOff: '#171411',
      text: '#E9E0D2', muted: '#B5A891', faint: '#7C7060', line: '#3A332C', accent: '#D9964A', red: '#E8806F', green: '#9CC27E',
    },
  },
];

// The palette picked, the first when the choice is unknown.
export const chosenTheme = (get) => THEMES.find((theme) => theme.value === get('calmTheme.palette')) ?? THEMES[0];
