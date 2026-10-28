import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const built = Bun.spawnSync([process.execPath, "run", "build:desktop"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if (built.exitCode !== 0) process.exit(built.exitCode);

const backendBuilt = Bun.spawnSync([process.execPath, "run", "build:backend"], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
if (backendBuilt.exitCode !== 0) process.exit(backendBuilt.exitCode);

const server = await createServer({ server: { host: "127.0.0.1", port: 5173, strictPort: true } });

await server.listen();

try {
  const electron = fileURLToPath(new URL("../node_modules/electron/cli.js", import.meta.url));

  const child = Bun.spawn([process.execPath, electron, "."], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PROJECT_KIT_DEV_URL: "http://127.0.0.1:5173" },
  });

  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    process.exitCode = await child.exited;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    child.kill();
  }
} finally {
  await server.close();
}
