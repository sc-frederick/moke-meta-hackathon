import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHostedDesktopRunner } from "./desktop-test-environment.ts";

// Hosted runners are disposable OS test sessions, including native Windows/macOS.
// This gate deliberately excludes generic CI and self-hosted Actions runners.
if (isHostedDesktopRunner(process.env)) {
  const directory = await mkdtemp(join(tmpdir(), "moke-hosted-desktop-"));

  try {
    const child = Bun.spawn(
      [process.execPath, "--bun", "playwright", "test", ...process.argv.slice(2), "--workers=1"],
      {
        env: {
          ...process.env,
          MOKE_TEST_RUNTIME: directory,
          MOKE_TEST_HOSTED_RUNNER: "1",
          MOKE_E2E_LIVE: "0",
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    process.exitCode = await child.exited;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  process.exit(process.exitCode ?? 1);
}

if (process.platform !== "linux")
  throw new Error("Local desktop proof requires the private Linux isolation runner.");

// Separate network and mount namespaces hide both abstract and filesystem X11 sockets.
if (process.platform === "linux" && process.env.MOKE_TEST_MOUNT_NAMESPACE !== "1") {
  const sandbox = Bun.which("unshare");

  if (!sandbox) throw new Error("unshare is required for a private X11 socket namespace.");

  const isolated = Bun.spawn(
    [
      sandbox,
      "--user",
      "--map-root-user",
      "--mount",
      "--net",
      "--ipc",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount-proc",
      "/bin/sh",
      "-c",
      'set -eu; mount -t tmpfs -o mode=1777 tmpfs /tmp/.X11-unix; if [ -d /mnt/wslg ]; then mount -t tmpfs -o mode=0700 tmpfs /mnt/wslg; fi; ip link set lo up; exec "$@"',
      "moke-private-session",
      process.execPath,
      import.meta.path,
      ...process.argv.slice(2),
    ],
    {
      env: { ...process.env, MOKE_TEST_MOUNT_NAMESPACE: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  process.exit(await isolated.exited);
}

// Never inherit a user's graphical session. Xvfb chooses and owns a fresh display.
const directory = await mkdtemp(join(tmpdir(), "moke-private-display-"));
const runtime = join(directory, "runtime");

await mkdir(runtime, { mode: 0o700 });

const executable = process.env.MOKE_XVFB_BINARY ?? Bun.which("Xvfb");

if (!executable)
  throw new Error(
    "Private Xvfb is required. Set MOKE_XVFB_BINARY; desktop tests never use the inherited display.",
  );

const environment = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined ||
    /^(DISPLAY|WAYLAND_DISPLAY|DBUS_|SESSION_MANAGER|PULSE_|PIPEWIRE_|XDG_CURRENT_DESKTOP|DESKTOP_SESSION|XAUTHORITY|ELECTRON_RUN_AS_NODE|MOKE_E2E_LIVE)/.test(
      key,
    )
      ? []
      : [[key, value]],
  ),
);

const server = Bun.spawn(
  [
    executable,
    ":99",
    "-displayfd",
    "1",
    "-screen",
    "0",
    "1600x1000x24",
    "-nolisten",
    "tcp",
    "-noreset",
  ],
  { env: environment, stdout: "pipe", stderr: "inherit" },
);

let child: ReturnType<typeof Bun.spawn> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

try {
  const display = await Promise.race([
    server.stdout
      .getReader()
      .read()
      .then((part) => new TextDecoder().decode(part.value).trim()),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Private Xvfb did not become ready.")), 5000);
    }),
  ]);

  if (timer) clearTimeout(timer);

  if (display !== "99" || server.exitCode !== null)
    throw new Error("Private Xvfb could not be confirmed.");
  const privateDisplay = `:${display}`;

  const probe = Bun.spawn(["xdpyinfo", "-display", privateDisplay], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const displayInfo = await new Response(probe.stdout).text();

  if ((await probe.exited) !== 0 || !/dimensions:\s+1600x1000 pixels/.test(displayInfo))
    throw new Error("Private display dimensions could not be verified; refusing GUI tests.");

  const desktopProbe = Bun.spawn(["timeout", "3", "xdpyinfo", "-display", ":0"], {
    env: environment,
    stdout: "ignore",
    stderr: "ignore",
  });

  if ((await desktopProbe.exited) === 0)
    throw new Error("Desktop display remains reachable; refusing GUI tests.");
  console.log(
    `Verified Xvfb ${privateDisplay} at 1600x1000; desktop :0 unreachable; private network/mount/PID/IPC, no desktop bus/audio/portals; one worker.`,
  );
  child = Bun.spawn(
    [process.execPath, "--bun", "playwright", "test", ...process.argv.slice(2), "--workers=1"],
    {
      env: {
        ...environment,
        DISPLAY: privateDisplay,
        MOKE_TEST_ISOLATED_DISPLAY: privateDisplay,
        MOKE_TEST_RUNTIME: runtime,
        XDG_RUNTIME_DIR: runtime,
        XDG_SESSION_TYPE: "x11",
        GDK_BACKEND: "x11",
        QT_QPA_PLATFORM: "xcb",
        GTK_USE_PORTAL: "0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
        DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/dev/null",
        PULSE_SERVER: "unix:/dev/null",
        PIPEWIRE_REMOTE: "disabled",
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
} finally {
  if (timer) clearTimeout(timer);

  if (child && child.exitCode === null) {
    child.kill();
    await child.exited;
  }

  server.kill();
  await server.exited;
  await rm(directory, { recursive: true, force: true });
}
