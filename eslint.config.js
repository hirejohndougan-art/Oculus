import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { dbRules } from "./eslint.db-rules.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "mockup/**",
      "tools/mockup-generator/**",
      ".gate/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.js"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  ...dbRules,
);
