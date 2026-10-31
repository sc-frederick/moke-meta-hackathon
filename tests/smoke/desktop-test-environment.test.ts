import { expect, test } from "bun:test";
import {
  assertDesktopTestEnvironment,
  isHostedDesktopRunner,
} from "../../scripts/desktop-test-environment.ts";

test("desktop guards accept only dedicated hosted runners or the private display", () => {
  for (const env of [
    { CI: "true" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" },
    { RUNNER_ENVIRONMENT: "github-hosted" },
  ]) {
    expect(isHostedDesktopRunner(env)).toBe(false);
    expect(() =>
      assertDesktopTestEnvironment({
        ...env,
        MOKE_TEST_RUNTIME: "/private",
        MOKE_TEST_HOSTED_RUNNER: "1",
        DISPLAY: ":0",
      }),
    ).toThrow("Inherited desktops");
  }

  const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };
  expect(isHostedDesktopRunner(hosted)).toBe(true);
  expect(() => assertDesktopTestEnvironment(hosted)).toThrow("private runtime");
  expect(() =>
    assertDesktopTestEnvironment({
      ...hosted,
      MOKE_TEST_RUNTIME: "/private",
      MOKE_TEST_HOSTED_RUNNER: "1",
    }),
  ).not.toThrow();

  const isolated = {
    MOKE_TEST_RUNTIME: "/private",
    MOKE_TEST_ISOLATED_DISPLAY: ":99",
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
  };

  expect(() => assertDesktopTestEnvironment(isolated)).not.toThrow();
  expect(() => assertDesktopTestEnvironment({ ...isolated, DISPLAY: ":0" })).toThrow(
    "Inherited desktops",
  );
  expect(() => assertDesktopTestEnvironment({ ...isolated, WAYLAND_DISPLAY: "wayland-0" })).toThrow(
    "Inherited desktops",
  );
});
