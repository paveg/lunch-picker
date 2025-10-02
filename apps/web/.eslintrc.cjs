module.exports = {
  root: true,
  env: {
    browser: true,
    es2023: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  overrides: [
    {
      files: ['*.svelte'],
      parser: 'svelte-eslint-parser',
      parserOptions: {
        parser: '@typescript-eslint/parser',
      },
      extends: ['plugin:svelte/recommended'],
    },
  ],
  rules: {
    'no-undef': 'off',
  },
  ignorePatterns: ['.svelte-kit', 'build', 'node_modules'],
};
