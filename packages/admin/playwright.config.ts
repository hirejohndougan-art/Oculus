// End-to-end tests (D-073): the built admin served by Fastify against a
// throwaway database (e2e/serve.mjs), driven by Playwright, with Siteimprove
// Alfa's accessibility rules on every screen it passes. Run with
// `npm run e2e` at the repository root (it builds first; e2e/run.mjs picks a
// free port unless OCULUS_E2E_PORT is set). Set
// OCULUS_E2E_BROWSER to a Chrome or Chromium binary to use it instead of
// Playwright's own download.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, defineConfig } from "@playwright/test";

const port = Number(process.env.OCULUS_E2E_PORT ?? "4173");
const seed = join(process.env.TMPDIR ?? tmpdir(), `oculus-e2e-seed-${String(port)}.json`);
process.env.OCULUS_E2E_SEED = seed;
/**
 * The browser: OCULUS_E2E_BROWSER if set; else Playwright's own Chromium if
 * it has been downloaded (`npx playwright install chromium`, as CI does);
 * else a system Chrome or Chromium at a usual path.
 */
function chooseBrowser(): string | undefined {
  const given = process.env.OCULUS_E2E_BROWSER;
  if (given !== undefined && given !== "") return given;
  if (existsSync(chromium.executablePath())) return undefined;
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) =>
    existsSync(p),
  );
}
const browser = chooseBrowser();

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${String(port)}`,
    ...(browser === undefined ? {} : { launchOptions: { executablePath: browser } }),
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `http://localhost:${String(port)}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: { OCULUS_E2E_PORT: String(port), OCULUS_E2E_SEED: seed },
  },
});
