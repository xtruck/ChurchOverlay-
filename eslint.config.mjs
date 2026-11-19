// Lint scope: the TypeScript sources (apps/, packages/, scripts/) AND, since
// P1-2, the vanilla-JS frontend surfaces (dashboard renderer, overlay, remote,
// stage, live) that previously were covered only by the source-reading tests.
// Rules start at typescript-eslint "recommended" (no type-aware rules) so the
// gate reports real defects without rewriting working code; tighten later.
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "release/**",
      "node_modules/**",
      "**/*.mjs",
      "**/*.cjs",
      // The dev-preview dashboard copy is a documented stale duplicate kept
      // for a later pass (ARCHITECTURE.md section 146 "Not done"): linting it
      // would report that drift, not a defect.
      "apps/overlay/dev-preview/**",
    ],
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
  {
    // P1-2: the no-build-step browser pages. They load as classic <script>
    // tags, so they lint as scripts with exactly the non-language globals the
    // probe found in use (standard JS builtins — Math, Promise, Uint8Array —
    // come from the language itself). The same two policies as the TS gate
    // apply: no empty catch without a reason, no dead names without a _.
    files: [
      "apps/desktop/renderer/**/*.js",
      "apps/overlay/public/**/*.js",
      "apps/remote/public/**/*.js",
      "apps/stage/public/**/*.js",
      "apps/live/public/**/*.js",
    ],
    languageOptions: {
      sourceType: "script",
      globals: {
        AudioContext: "readonly",
        AudioWorkletNode: "readonly",
        AudioWorkletProcessor: "readonly",
        Blob: "readonly",
        CustomEvent: "readonly",
        Element: "readonly",
        Event: "readonly",
        MutationObserver: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        fetch: "readonly",
        getComputedStyle: "readonly",
        localStorage: "readonly",
        module: "readonly",
        navigator: "readonly",
        performance: "readonly",
        registerProcessor: "readonly",
        requestAnimationFrame: "readonly",
        self: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      // The core rule (with the _ patterns) governs the JS files; the
      // typescript-eslint variant from "recommended" has no such patterns and
      // must not double-report here.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
)
