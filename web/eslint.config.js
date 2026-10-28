import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const browserSources = [
  'app/**/*.{ts,tsx}',
  'components/**/*.{ts,tsx}',
  'hooks/**/*.{ts,tsx}',
];

const uiSources = ['components/ui/**/*.tsx'];

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: browserSources,
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Fast refresh only applies to the component layer; the router module also
    // exports loaders.
    files: ['components/**/*.{ts,tsx}', 'hooks/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': [
        'error',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: uiSources,
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
    files: ['components/**/*.tsx'],
    ignores: [...uiSources, '**/*.test.tsx'],
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
