// Flat ESLint config. Pragmatic: catches real bugs (unused vars, undefined
// globals, shadowing) without drowning a plain-JS codebase in style rules.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '.git/**', '**/*.min.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-async-promise-executor': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'require-atomic-updates': 'off', // false positives around await in this pipeline
      'no-console': 'off',             // CLI/runtime logs via console are intentional
    },
  },
];
