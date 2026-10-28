import { app, BrowserWindow, dialog, Menu, net, protocol } from "electron";
import { Effect, Layer, Logger, ManagedRuntime, Schema } from "effect";
import { MainRpcServer } from "electron-effect-rpc/main";
import { appendFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ReviewDesktopRpc, ReviewShellRpc } from "../src/lib/review/shell.ts";
import { ReviewStorageError } from "../src/lib/review/contracts.ts";
import { BackendApi, type BackendLaunch } from "./backend.ts";
import { ReviewProxy, ExecutionProxy } from "./review-proxy.ts";
import { readInferenceConfiguration, storeInferenceConfiguration } from "./credentials.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const root = fileURLToPath(new URL("../../", import.meta.url));
const developmentUrl = app.isPackaged ? undefined : process.env.PROJECT_KIT_DEV_URL;
const trustedOrigin = developmentUrl === undefined ? "app://app" : new URL(developmentUrl).origin;
const trusted = (url: string) => url === trustedOrigin || url.startsWith(`${trustedOrigin}/`);

if (
  developmentUrl !== undefined &&
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(developmentUrl)
) {
  throw new Error("Desktop development requires a loopback Vite URL.");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      const dataDirectory = process.env.PROJECT_KIT_DATA_DIRECTORY ?? app.getPath("userData");

      const migrationDirectory = app.isPackaged
        ? join(process.resourcesPath, "migrations")
        : join(root, "migrations");

      await mkdir(join(dataDirectory, "logs"), { recursive: true });
      const logFile = join(dataDirectory, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`);

      const fileLogger = Logger.make((options) => {
        appendFileSync(logFile, Logger.formatJson.log(options) + "\n");
      });

      const logging = Logger.layer([fileLogger, Logger.consoleJson]);

      const executable = process.platform === "win32" ? "app-backend.exe" : "app-backend";

      const backendDirectory = app.isPackaged
        ? join(process.resourcesPath, "backend")
        : join(root, "dist/backend");

      const assetDirectory = join(backendDirectory, "pdf-assets");

      const layout = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            nativeFile: Schema.String.check(Schema.isPattern(/^skia\.[a-z0-9-]+\.node$/)),
          }),
        ),
      )(await readFile(join(assetDirectory, "layout.json"), "utf8"));

      const inference = await readInferenceConfiguration(dataDirectory, app.isPackaged);

      const launchOptions: BackendLaunch = {
        command: app.isPackaged
          ? [join(process.resourcesPath, "backend", executable)]
          : ["bun", "--no-orphans", join(root, "backend/main.ts")],
        dataDirectory,
        migrationDirectory,
        processing: {
          workerCommand: [
            join(backendDirectory, process.platform === "win32" ? "pdf-worker.exe" : "pdf-worker"),
          ],
          assetsDirectory: join(assetDirectory, "pdfjs"),
          nativeLibraryPath: join(assetDirectory, "native", layout.nativeFile),
        },
        onUnexpectedExit: () => {
          dialog.showErrorBox(
            "Backend stopped",
            "The application service stopped unexpectedly. Please reopen the app.",
          );
          app.quit();
        },
      };

      const backend = BackendApi.layer(
        inference === undefined ? launchOptions : { ...launchOptions, inference },
      );

      const shellHandlers = ReviewShellRpc.toLayer(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;

          return {
            ChooseReviewPdf: (request) =>
              Effect.tryPromise({
                try: () =>
                  dialog.showOpenDialog({
                    properties: ["openFile"],
                    filters: [{ name: "Drawing PDF", extensions: ["pdf"] }],
                  }),
                catch: () =>
                  new ReviewStorageError({ message: "The drawing chooser could not open." }),
              }).pipe(
                Effect.flatMap((result) => {
                  const source = result.filePaths[0];

                  return result.canceled || source === undefined
                    ? Effect.succeed(null)
                    : api.ImportReviewPdf({ ...request, source, name: basename(source) }).pipe(
                        Effect.mapError(
                          () =>
                            new ReviewStorageError({
                              message:
                                "The PDF could not be imported. Check the source and reload the project.",
                            }),
                        ),
                      );
                }),
              ),
            ChooseReviewExport: () =>
              Effect.tryPromise({
                try: () =>
                  dialog.showOpenDialog({
                    title: "Choose the parent folder for a complete review package",
                    properties: ["openDirectory", "createDirectory"],
                  }),
                catch: () =>
                  new ReviewStorageError({ message: "The package folder chooser could not open." }),
              }).pipe(
                Effect.flatMap((result) => {
                  const parent = result.filePaths[0];

                  if (result.canceled || parent === undefined) return Effect.succeed(false);

                  const destination = join(
                    parent,
                    `Moke-review-${new Date().toISOString().replaceAll(":", "-")}`,
                  );

                  return api.ExportReviewPackage({ destination }).pipe(
                    Effect.as(true),
                    Effect.mapError(
                      () =>
                        new ReviewStorageError({
                          message:
                            "The complete review package could not be exported. Check available storage and unresolved work.",
                        }),
                    ),
                  );
                }),
              ),
            ChooseReviewRestore: () =>
              Effect.tryPromise({
                try: async () => {
                  const result = await dialog.showOpenDialog({
                    title: "Choose a complete Moke review package",
                    properties: ["openDirectory"],
                  });

                  const source = result.filePaths[0];

                  if (result.canceled || source === undefined) return undefined;

                  const confirmation = await dialog.showMessageBox({
                    type: "warning",
                    buttons: ["Cancel", "Restore complete package"],
                    defaultId: 0,
                    cancelId: 0,
                    message: "Replace local projects with this package?",
                    detail:
                      "A complete pre-restore package is retained. Restored reviews open as non-executing history. The app restarts after restore.",
                  });

                  return confirmation.response === 1 ? source : undefined;
                },
                catch: () =>
                  new ReviewStorageError({ message: "The restore chooser could not open." }),
              }).pipe(
                Effect.flatMap((source) =>
                  source === undefined
                    ? Effect.succeed(false)
                    : api.RestoreReviewPackage({ source }).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            app.relaunch();
                            app.quit();
                          }),
                        ),
                        Effect.as(true),
                        Effect.mapError(
                          () =>
                            new ReviewStorageError({
                              message:
                                "The review package could not be restored. Existing data was preserved; reopen the app if recovery is required.",
                            }),
                        ),
                      ),
                ),
              ),
          };
        }),
      );

      const server = MainRpcServer.layer(ReviewDesktopRpc, {
        authorize: ({ frame }) =>
          frame !== null && frame !== undefined && frame.parent === null && trusted(frame.url),
      }).pipe(
        Layer.provide(Layer.mergeAll(ReviewProxy, ExecutionProxy, shellHandlers)),
        Layer.provideMerge(backend),
        Layer.provide(logging),
      );

      const runtime = ManagedRuntime.make(server);

      try {
        await runtime.runPromise(Effect.logInfo("Desktop RPC and Bun backend are ready."));
      } catch {
        dialog.showErrorBox(
          "Unable to start",
          "The application service could not start or migrate its database. Existing data was preserved. Check the application logs.",
        );
        await runtime.dispose();
        app.exit(1);

        return;
      }

      const buildRoot = join(root, "build");
      protocol.handle("app", async (request) => {
        const url = new URL(request.url);

        if (url.hostname !== "app" || request.method !== "GET")
          return new Response("Not found", { status: 404 });

        const path = resolve(
          buildRoot,
          `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
        );

        const rel = relative(buildRoot, path);

        if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
          return new Response("Not found", { status: 404 });

        return net.fetch(pathToFileURL(path).href);
      });

      const createWindow = async () => {
        const window = new BrowserWindow({
          width: 1100,
          height: 760,
          webPreferences: {
            preload: join(root, "dist/preload/preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });

        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event, url) => {
          if (!trusted(url)) event.preventDefault();
        });
        window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
        await window.loadURL(developmentUrl ?? "app://app/index.html");
      };

      const showFailure = () =>
        dialog.showErrorBox(
          "Data operation failed",
          "The operation did not complete. Your existing database was preserved.",
        );

      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "File",
            submenu: [
              {
                label: "Export complete review package…",
                click: () => {
                  void runtime
                    .runPromise(
                      Effect.flatMap(BackendApi, ({ api }) =>
                        Effect.tryPromise({
                          try: () =>
                            dialog.showOpenDialog({
                              title: "Choose export parent folder",
                              properties: ["openDirectory", "createDirectory"],
                            }),
                          catch: () =>
                            new ReviewStorageError({ message: "The folder chooser failed." }),
                        }).pipe(
                          Effect.flatMap((selection) =>
                            selection.canceled || selection.filePaths[0] === undefined
                              ? Effect.void
                              : api
                                  .ExportReviewPackage({
                                    destination: join(
                                      selection.filePaths[0],
                                      `Moke-review-${new Date().toISOString().replaceAll(":", "-")}`,
                                    ),
                                  })
                                  .pipe(Effect.asVoid),
                          ),
                        ),
                      ),
                    )
                    .catch(showFailure);
                },
              },
              {
                label: "Import provider credential configuration…",
                click: async () => {
                  const result = await dialog.showOpenDialog({
                    properties: ["openFile"],
                    filters: [{ name: "Provider credential configuration", extensions: ["json"] }],
                  });

                  const source = result.filePaths[0];

                  if (result.canceled || source === undefined) return;

                  try {
                    await storeInferenceConfiguration(dataDirectory, source);
                    app.relaunch();
                    app.quit();
                  } catch {
                    dialog.showErrorBox(
                      "Credential unavailable",
                      "The configuration could not be saved with OS encryption. Select an explicit session-only configuration when secure storage is unavailable.",
                    );
                  }
                },
              },
              {
                label: "Export database (partial)…",
                click: async () => {
                  const result = await dialog.showSaveDialog({
                    defaultPath: "app-backup.sqlite",
                    filters: [{ name: "SQLite backup", extensions: ["sqlite"] }],
                  });

                  if (result.canceled || result.filePath === undefined) return;

                  const destination = result.filePath;
                  await runtime
                    .runPromise(
                      Effect.flatMap(BackendApi, ({ api }) => api.ExportDatabase({ destination })),
                    )
                    .catch(showFailure);
                },
              },
              {
                label: "Restore database…",
                click: async () => {
                  const result = await dialog.showOpenDialog({
                    properties: ["openFile"],
                    filters: [{ name: "SQLite backup", extensions: ["sqlite"] }],
                  });

                  const source = result.filePaths[0];

                  if (result.canceled || source === undefined) return;

                  const confirmation = await dialog.showMessageBox({
                    type: "warning",
                    buttons: ["Cancel", "Restore and restart"],
                    defaultId: 0,
                    cancelId: 0,
                    message: "Restore this database backup?",
                    detail: "A backup of the current database will be kept. The app will restart.",
                  });

                  if (confirmation.response !== 1) return;

                  try {
                    await runtime.runPromise(
                      Effect.flatMap(BackendApi, ({ api }) => api.RestoreDatabase({ source })),
                    );
                  } catch {
                    showFailure();

                    return;
                  }

                  app.relaunch();
                  app.quit();
                },
              },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]),
      );

      await createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
      app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
      });

      let quitting = false;
      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        void runtime.dispose().then(
          () => app.quit(),
          () => app.exit(1),
        );
      });
    })
    .catch((error) => {
      console.error("Desktop startup failed", error);
      app.exit(1);
    });
}
