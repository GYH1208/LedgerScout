import { createWebServer } from "./server.js";
const server = createWebServer();
server.listen(4174, "127.0.0.1", async () => {
  if (await server.ready) console.log("LedgerScout local API: http://127.0.0.1:4174");
  else console.error("LedgerScout local history unavailable; inspect the live page for the next step.");
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
