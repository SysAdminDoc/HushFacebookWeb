import js from '@eslint/js';
import globals from 'globals';

export default [
  // Flat config doesn't read .gitignore, so local-only folders are listed here too.
  { ignores: ['dist/', 'node_modules/', 'coverage/', '.claude/', 'captures/', '.mockups/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.greasemonkey,
        exportFunction: 'readonly',
        __HFW_VERSION__: 'readonly',
        __HFW_TARGET__: 'readonly',
      },
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['tests/browser/fixtures/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, __HFW_VERSION__: 'readonly' },
    },
  },
  {
    files: ['tests/browser/runner.mjs'],
    languageOptions: { globals: { window: 'readonly' } },
  },
];
