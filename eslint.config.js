// ESLint flat config (ESLint 9). ESM because the package is `"type": "module"`.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output, dependencies, and the local-only context directory.
    // `.dev-docs/` holds the (locally gitignored) development notes and probe
    // scripts and is deliberately not linted.
    ignores: ['lib/**', 'dist/**', 'coverage/**', 'node_modules/**', '.dev-docs/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Tooling files run on Node with ESM and are not part of the published
    // plugin surface. Declaring the handful of Node globals used here avoids
    // adding a `globals` dependency for four identifiers.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },

  {
    // The browser half is a plain script the DSH module loader serves as-is:
    // it runs in the page, not on Node, so it gets the browser globals instead.
    files: ['client.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
      },
    },
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // The plugin talks to DSH/Cordis APIs whose shapes are documented in
      // .dev-docs/DSH-API-NOTES.md; unused parameters are common in hook
      // signatures and are handled by tsc's noUnusedParameters instead.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Public API types are re-exported; explicit return types keep the
      // generated .d.ts stable.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
)
