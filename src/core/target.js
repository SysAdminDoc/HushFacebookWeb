// Which build this is: 'userscript' (dist/hushfacebook-web.user.js) or 'extension'
// (dist/extension/, where src/core/bridge.js stands in for the userscript manager).
export const TARGET = typeof __HFW_TARGET__ !== 'undefined' ? __HFW_TARGET__ : 'userscript';

// What keeps the settings, as messages name it at the start of a sentence.
export const KEEPER = TARGET === 'extension' ? 'The extension' : 'Your userscript manager';
