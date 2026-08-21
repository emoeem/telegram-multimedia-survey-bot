import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ["node_modules/**", "delivery/**", ".wrangler/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
  },
];
