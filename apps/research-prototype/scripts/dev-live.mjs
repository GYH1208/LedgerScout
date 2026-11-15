import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  app = fileURLToPath(new URL("../", import.meta.url));
const api = spawn(
  process.execPath,
  ["--import", "tsx", "packages/web-server/src/main.ts"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY
        ? { NODE_USE_ENV_PROXY: "1" }
        : {}),
    },
  }
);
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
    ...process.argv.slice(2),
  ],
  { cwd: app, stdio: "inherit" }
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  vite.kill("SIGTERM");
  process.exitCode = code;
}
api.on("exit", (code) => stop(code ?? 1));
vite.on("exit", (code) => stop(code ?? 1));
api.on("error", () => stop(1));
vite.on("error", () => stop(1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
