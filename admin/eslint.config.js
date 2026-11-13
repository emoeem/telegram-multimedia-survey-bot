// admin 前端独立 lint 入口：根 eslint.config.js 显式 ignore 了 admin/**，
// 根 `lint` script（eslint . --ext .ts）不覆盖 admin/src 的 tsx 代码。
// 依赖直接复用根 node_modules 的 eslint + @typescript-eslint/parser。
// react-hooks 插件必须注册：8 个源文件里 inline eslint-disable 引用了
// exhaustive-deps，不注册的话 ESLint 直接报「rule not found」。
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tsParser },
    plugins: { "react-hooks": reactHooks },
  },
  {
    rules: {
      // 启用 hooks 两条规则（与 create-react-app / vite 模板默认一致）。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
