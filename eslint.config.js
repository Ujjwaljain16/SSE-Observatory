import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
    // TypeScript files (src)
    {
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'react-hooks': reactHooksPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            'react-hooks/rules-of-hooks': 'error',
            // Disabled — hooks intentionally omit some deps for performance reasons
            'react-hooks/exhaustive-deps': 'off',
            // Disabled — codebase uses `any` intentionally in worker bridges / test mocks
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': 'off',
        },
    },

    // Ignore build/generated output
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            'coverage/**',
            'public/**',
            'docs/**',
            '*.config.js',
            '*.config.ts',
            'api/**',
            'test-servers/**',
        ],
    },
]
