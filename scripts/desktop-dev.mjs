import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

const vp = fileURLToPath(new URL("../node_modules/vite-plus/bin/vp", import.meta.url));
const built = spawnSync(process.execPath, [vp, "pack"], { stdio: "inherit" });

if (built.status !== 0) process.exit(built.status ?? 1);

const server = await createServer({ server: { host: "127.0.0.1", port: 5173, strictPort: true } });

await server.listen();

const electron = fileURLToPath(new URL("../node_modules/electron/cli.js", import.meta.url));

const child = spawn(process.execPath, [electron, "."], {
  stdio: "inherit",
  env: { ...process.env, PROJECT_KIT_DEV_URL: "http://127.0.0.1:5173" },
});

child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 1);
});

process.once("SIGINT", () => child.kill("SIGINT"));

process.once("SIGTERM", () => child.kill("SIGTERM"));
