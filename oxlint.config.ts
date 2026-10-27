import { defineConfig } from "oxlint";
import { lintSettings } from "./tools/lint.ts";

export default defineConfig(lintSettings());
