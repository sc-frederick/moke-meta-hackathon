import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 45000,
  projects: [{ name: "desktop" }, { name: "screenshots", testMatch: "review.spec.ts" }],
});
