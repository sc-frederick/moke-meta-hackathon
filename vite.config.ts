import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

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
});
