import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
    {
        ignores: [
            'dist/**', 'dist-cli/**', 'node_modules/**', 'coverage/**', 'public/**', 'docs/**',
            'playwright-report/**', 'test-results/**', 'blob-report/**', '.vercel/**',
            'vite.config.js', 'audit-evidence/**', '.agents/**', '.claude/**', // vite.config.js is emitted by tsc -b
        ],
    },

    // Backend, scripts, test servers and config files (plain ESM JavaScript on Node)
    {
        files: ['**/*.{js,mjs,cjs}'],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },

    // Browser-driving scripts: they run on Node, but their page.evaluate callbacks run in the page
    {
        files: ['scripts/bench.mjs', 'scripts/screenshots.mjs'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },

    // Frontend (React + TypeScript)
    {
        files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts', '*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
            globals: { ...globals.browser, ...globals.worker },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'react-hooks': reactHooksPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            'react-hooks/rules-of-hooks': 'error',
            // Ratchet: warnings are capped by --max-warnings in package.json and must only go down.
            'react-hooks/exhaustive-deps': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },

    // The shared core, the Node CLI and the fixture servers run without a DOM. tsconfig.core.json already fails the
    // typecheck on DOM names; this also blocks the browser globals that the block above adds, and keeps React and the
    // app layers out of code the CLI bundles.
    {
        files: ['src/core/**/*.ts', 'src/cli/**/*.ts', 'src/fixtures/**/*.ts'],
        ignores: ['**/__tests__/**', '**/*.test.ts'],
        rules: {
            'no-restricted-globals': ['error',
                ...['window', 'document', 'localStorage', 'sessionStorage', 'self', 'navigator', 'indexedDB', 'location', 'Worker', 'SharedWorker', 'requestAnimationFrame', 'cancelAnimationFrame']
                    .map((name) => ({ name, message: 'Not available in the shared core, CLI or fixtures (they run without a DOM).' })),
            ],
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['react', 'react-dom', 'react/*', 'react-dom/*', '**/components/**', '**/hooks/**', '**/context/**', '**/workers/**', '**/utils/**'],
                    message: 'Core, CLI and fixtures must not import React or the app layers. Put shared logic in src/core.',
                }],
            }],
        },
    },

    // And the other way round: the browser bundle must never pull in the Node-only CLI or fixture servers.
    {
        files: ['src/components/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}', 'src/workers/**/*.ts', 'src/context/**/*.{ts,tsx}', 'src/utils/**/*.ts', 'src/doctor/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{ group: ['**/cli/**', '**/fixtures/**'], message: 'The CLI and fixture servers are Node-only and must not end up in the browser bundle.' }],
            }],
        },
    },

    // Tests may be looser
    {
        files: ['**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'e2e/**'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },
]
