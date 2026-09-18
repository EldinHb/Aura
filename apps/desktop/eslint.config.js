import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import requireDataCommand from "./eslint-rules/require-data-command.js";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri", "src/gen", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.es2022 }, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { local: { rules: { "require-data-command": requireDataCommand } }, "react-hooks": reactHooks },
    rules: {
      "local/require-data-command": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
