// ESLint v10 (flat config). Remplace .eslintrc.json, incompatible depuis
// ESLint v9 (le format `.eslintrc.*` + `extends` n'est plus chargé du
// tout : `npm run lint` échouait immédiatement avec "ESLint couldn't find
// an eslint.config.js file", donc plus aucun fichier n'était jamais linté).
//
// Autre bug corrigé au passage : l'ancien `.eslintrc.json` avait
// `"ignorePatterns": ["*.js"]`, qui exclut TOUS les fichiers .js du lint —
// soit à peu près tout le code source réel du projet (server.js, main.js,
// detector.js, etc.), ne laissant que les quelques fichiers .ts. Ce n'était
// presque certainement pas l'intention (on ne lint pas un projet pour
// ignorer son code) : retiré ci-dessous.

'use strict';

const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'config/**', 'test/**', '*.min.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: { prettier: prettierPlugin },
    rules: {
      'prettier/prettier': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // catch (_) {} : rejet volontaire "best effort" (nettoyage optionnel
      // qui ne doit jamais faire planter l'app) — motif intentionnel
      // répété ~14 fois dans le code, pas une erreur à corriger au cas par
      // cas.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // AudioWorkletGlobalScope (audio-capture-worklet.js) : scope global
    // séparé du DOM/window, avec ses propres globales (registerProcessor,
    // sampleRate, currentFrame, currentTime, AudioWorkletProcessor) que ni
    // globals.browser ni globals.node ne connaissent.
    files: ['audio-capture-worklet.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
      },
    },
    plugins: { prettier: prettierPlugin },
    rules: {
      'prettier/prettier': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': 'off',
    },
  },
  prettierConfig,
];
