import js from '@eslint/js';
import globals from 'globals';

export default [
  // Flat config doesn't read .gitignore, so local-only folders are listed here too.
  { ignores: ['dist/', 'node_modules/', 'coverage/', '.claude/', 'captures/'] },
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
      },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
