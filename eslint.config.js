import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.agents/skills/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: {
      // shadcn intentionally co-locates variants and Sidebar context exports.
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          allowExportNames: [
            'buttonVariants',
            'badgeVariants',
            'toggleVariants',
            'markerVariants',
            'useSidebar',
            'useMessageScroller',
            'useMessageScrollerScrollable',
            'useMessageScrollerVisibility',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    ignores: ['apps/web/src/components/ui/**', 'apps/web/src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXOpeningElement[name.name=/^(button|input|textarea|select)$/]',
          message:
            'Use the shadcn control from @/components/ui; keep variants and interaction behavior consistent.',
        },
        {
          selector:
            'CallExpression[callee.object.name="window"][callee.property.name="confirm"]',
          message:
            'Use shadcn AlertDialog through useConfirmation for accessible confirmation.',
        },
      ],
    },
  },
];
