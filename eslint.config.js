import antfu from '@antfu/eslint-config';

export default antfu({
  type: 'lib',
  typescript: true,
  jsonc: false,
  yaml: false,
  markdown: false,
  stylistic: {
    semi: true,
  },
  ignores: ['dist/', 'node_modules/'],
  rules: {
    'node/prefer-global/process': 'off',
  },
});
