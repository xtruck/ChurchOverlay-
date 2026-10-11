// Lint scope: the TypeScript sources only (apps/, packages/, scripts/).
// The browser pages (vanilla JS under apps/*/public and the dashboard
// renderer) are covered by the source-reading tests, not by this config.
// Rules start at typescript-eslint "recommended" (no type-aware rules) so the
// gate reports real defects without rewriting working code; tighten later.
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "release/**", "node_modules/**", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // AGENTS.md section 25: an empty catch must carry a documented reason.
      "no-empty": ["error", { allowEmptyCatch: false }],
      // Unused names prefixed with _ are intentional.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
)
