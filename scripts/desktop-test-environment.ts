/** Only disposable GitHub-hosted runners may use their platform's native test desktop. */
export const isHostedDesktopRunner = (environment: NodeJS.ProcessEnv) =>
  environment.GITHUB_ACTIONS === "true" && environment.RUNNER_ENVIRONMENT === "github-hosted";

/** Fail closed before Electron can access any local graphical session. */
export function assertDesktopTestEnvironment(environment: NodeJS.ProcessEnv) {
  if (!environment.MOKE_TEST_RUNTIME)
    throw new Error("Desktop tests require a private runtime/profile directory.");

  if (environment.MOKE_TEST_HOSTED_RUNNER === "1" && isHostedDesktopRunner(environment)) return;

  if (
    !environment.MOKE_TEST_ISOLATED_DISPLAY ||
    environment.DISPLAY !== environment.MOKE_TEST_ISOLATED_DISPLAY ||
    environment.WAYLAND_DISPLAY ||
    environment.DBUS_SESSION_BUS_ADDRESS !== "unix:path=/dev/null"
  )
    throw new Error(
      "Run desktop proof through scripts/isolated-desktop.ts. Inherited desktops are forbidden.",
    );
}
