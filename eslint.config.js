// ESLint 10 flat config (replaces .eslintrc.cjs).
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default [
  { ignores: ['dist/', '.astro/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // TypeScript resolves ambient/global types (DOM lib, workers-types);
      // no-undef is redundant here and false-positives on type-only names.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Enforce CLAUDE.md's "no `any` without an inline justification comment":
      // each `any` must carry an explicit eslint-disable directive.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Astro components: parser + recommended rules (flat config from the plugin).
  ...astro.configs.recommended,
];
