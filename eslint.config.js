import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
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
  // The admin's React code (D-073): the rules of hooks, and their newer
  // checks (purity, refs, effects) from the plugin's recommended set.
  {
    files: ["packages/admin/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ["scripts/**/*.mjs", "*.js", "packages/admin/e2e/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  ...dbRules,
);
