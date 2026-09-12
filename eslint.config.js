import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**", "delivery/**", ".wrangler/**", "admin/**", "blog-source-migrate/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
  },
];
