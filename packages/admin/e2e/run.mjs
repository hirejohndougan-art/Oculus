// `npm run e2e -w @oculus/admin`: runs Playwright on a free port (asked of
// the system), unless OCULUS_E2E_PORT names one, so two gates on one
// machine don't collide. Arguments are passed on to `playwright test`.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

const port = process.env.OCULUS_E2E_PORT ?? String(await freePort());
const child = spawn("npx", ["playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, OCULUS_E2E_PORT: port },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
