import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";
import { formatIgnores, lintSettings } from "./tools/lint.ts";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter(),
      router: { type: "hash" },
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["self"],
          "script-src": ["self"],
          "style-src": ["self", "unsafe-inline"],
          "connect-src": ["self"],
          "img-src": ["self", "data:"],
          "object-src": ["none"],
          "frame-src": ["none"],
        },
      },
    }),
  ],
  lint: lintSettings(),
  fmt: { svelte: true, ignorePatterns: formatIgnores },
  test: { include: ["tests/**/*.test.ts"] },
  pack: [
    {
      entry: ["desktop/main.ts"],
      outDir: "dist/electron",
      format: "esm",
      platform: "node",
      dts: false,
      clean: true,
      inputOptions: { external: ["electron"] },
      outExtensions: () => ({ js: ".mjs" }),
    },
    {
      entry: ["desktop/preload.ts"],
      outDir: "dist/preload",
      format: "cjs",
      platform: "node",
      dts: false,
      inputOptions: { external: ["electron"] },
      deps: { alwaysBundle: [/^electron-effect-rpc(\/|$)/, /^effect(\/|$)/], onlyBundle: false },
    },
  ],
});
