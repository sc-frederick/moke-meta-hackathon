import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vp = fileURLToPath(new URL("../node_modules/vite-plus/bin/vp", import.meta.url));
const result = spawnSync(process.execPath, [vp, "pack"], { stdio: "inherit" });

process.exit(result.status ?? 1);
