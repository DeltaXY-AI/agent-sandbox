import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  fetch: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: nodeGlobals } },
  // Demo scripts and the acceptance script read loosely shaped JSON responses.
  {
    files: ["scripts/**", "test/acceptance/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
