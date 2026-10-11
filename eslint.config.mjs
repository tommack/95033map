// npm run lint: catches undefined and unused variables in the browser code, which has no other checks.
import globals from 'globals';

export default [
  { ignores: ['tools/node-picker/vendor/', 'site/data/', 'node_modules/'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.node, L: 'readonly' } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
    },
  },
];
