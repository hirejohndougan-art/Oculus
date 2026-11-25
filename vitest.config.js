import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run before the build, so packages import each other's sources.
    alias: {
      "@oculus/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@oculus/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@oculus/service": fileURLToPath(new URL("./packages/service/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Generous limits for a busy machine (U-008): scrypt sign-ins, several
    // connections and a fresh database's migrations can pass vitest's 5 s
    // default when other work shares the CPUs. A test that hangs still fails.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // `*.test.tsx` are the admin's screen tests (D-073); each says
    // `// @vitest-environment jsdom` at the top.
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
    ],
  },
});
