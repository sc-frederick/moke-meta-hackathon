import { Match } from "effect";

const patterns = {
  linux: "release/linux*-unpacked/moke-meta-hackathon",
  win32: "release/win*-unpacked/moke-meta-hackathon.exe",
  darwin: "release/mac*/moke-meta-hackathon.app/Contents/MacOS/moke-meta-hackathon",
};

const pattern = Match.value(process.platform).pipe(
  Match.when("linux", () => patterns.linux),
  Match.when("win32", () => patterns.win32),
  Match.when("darwin", () => patterns.darwin),
  Match.orElse(() => undefined),
);

if (pattern === undefined) {
  console.error("Packaged desktop tests require Linux, Windows, or macOS.");
  process.exit(1);
}

const executables = Array.from(new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true }));
const executable = executables[0];

if (executable === undefined || executables.length !== 1) {
  console.error(
    "Expected exactly one packaged desktop application. Clean release/ and package the app first.",
  );
  process.exit(1);
}

const child = Bun.spawn([process.execPath, "run", "test:e2e"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, PROJECT_KIT_EXECUTABLE: executable },
});

process.exitCode = await child.exited;
