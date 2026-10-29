import { _electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDesktopTestEnvironment,
  isHostedDesktopRunner,
} from "../../scripts/desktop-test-environment.ts";

/** Launch only on the wrapper's private Xvfb, with an isolated profile and no desktop services. */
export const electron = {
  async launch(options: NonNullable<Parameters<typeof _electron.launch>[0]>) {
    const display = process.env.MOKE_TEST_ISOLATED_DISPLAY;
    const runtime = process.env.MOKE_TEST_RUNTIME;

    assertDesktopTestEnvironment(process.env);

    if (!runtime) throw new Error("Missing private test runtime.");

    const hosted =
      process.env.MOKE_TEST_HOSTED_RUNNER === "1" && isHostedDesktopRunner(process.env);

    const profile = await mkdtemp(join(runtime, "electron-"));

    const launchOptions = { ...options };

    if (process.env.PROJECT_KIT_EXECUTABLE)
      launchOptions.executablePath = process.env.PROJECT_KIT_EXECUTABLE;

    return _electron.launch({
      ...launchOptions,
      args: [
        ...(options.args ?? []).filter(
          (argument) => !process.env.PROJECT_KIT_EXECUTABLE || argument !== ".",
        ),
        `--user-data-dir=${profile}`,
        ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
        "--no-sandbox",
        "--mute-audio",
        "--disable-notifications",
        "--disable-features=WebNotifications,AudioServiceOutOfProcess,WebShare,GlobalShortcutsPortal",
        "--disable-background-networking",
      ],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).flatMap(([key, value]) =>
            value === undefined ||
            [
              "ELECTRON_RUN_AS_NODE",
              "MODEL_API_KEY",
              "BASETEN_API_KEY",
              "MOKE_SESSION_CREDENTIAL_FILE",
            ].includes(key)
              ? []
              : [[key, value]],
          ),
        ),
        ...Object.fromEntries(
          Object.entries(options.env ?? {}).filter(([, value]) => value !== ""),
        ),
        DISPLAY: hosted ? (process.env.DISPLAY ?? "") : (display ?? ""),
        WAYLAND_DISPLAY: "",
        XDG_RUNTIME_DIR: runtime,
        XDG_CURRENT_DESKTOP: "",
        DESKTOP_SESSION: "",
        SESSION_MANAGER: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
        DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/dev/null",
        GTK_USE_PORTAL: "0",
        PULSE_SERVER: "unix:/dev/null",
        PIPEWIRE_REMOTE: "disabled",
      },
    });
  },
};
