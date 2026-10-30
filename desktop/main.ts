import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  shell,
} from "electron";
import { Effect, Layer, Logger, ManagedRuntime, Option, Schema } from "effect";
import { MainRpcServer } from "electron-effect-rpc/main";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ReviewDesktopRpc, ReviewShellRpc } from "../src/lib/review/shell.ts";
import { ReviewError, ReviewStorageError } from "../src/lib/review/contracts.ts";
import { cachedPromptShare } from "../src/lib/review/packet.ts";
import { BackendApi, type BackendLaunch } from "./backend.ts";
import { ReviewProxy, ExecutionProxy, PacketProxy, CloudReviewProxy } from "./review-proxy.ts";
import { readInferenceConfigurations, storeInferenceConfiguration } from "./credentials.ts";
import { readModalConfiguration } from "./modal-credentials.ts";
import { createDropImports } from "./drop-imports.ts";

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
            platform: Schema.Literal(process.platform),
            arch: Schema.Literal(process.arch),
            nativeFile: Schema.String.check(Schema.isPattern(/^skia\.[a-z0-9-]+\.node$/)),
          }),
        ),
      )(await readFile(join(assetDirectory, "layout.json"), "utf8"));

      const [inference, ...inferenceAlternatives] = await readInferenceConfigurations(
        dataDirectory,
        app.isPackaged,
      );

      const modal = await Effect.runPromise(readModalConfiguration(app.isPackaged));

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

      const withInference =
        inference === undefined
          ? launchOptions
          : { ...launchOptions, inference, inferenceAlternatives };

      const backend = BackendApi.layer(
        modal === undefined ? withInference : { ...withInference, modal },
      );

      const preferencesPath = join(dataDirectory, "import-preferences.json");
      const Preferences = Schema.Struct({ directory: Schema.String });
      let importDirectory: string | undefined;

      try {
        importDirectory = Schema.decodeUnknownSync(Schema.fromJsonString(Preferences))(
          await readFile(preferencesPath, "utf8"),
        ).directory;
      } catch {
        /* A missing or invalid chooser preference never blocks source import. */
      }

      const drops = createDropImports();
      ipcMain.handle("moke:stage-pdf", async (event, value) => {
        if (
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !trusted(event.senderFrame.url)
        )
          return null;
        const decoded = Schema.decodeUnknownOption(Schema.String)(value);

        if (Option.isNone(decoded)) return null;
        const source = decoded.value;

        if (!isAbsolute(source) || extname(source).toLowerCase() !== ".pdf") return null;

        try {
          if (!(await stat(source)).isFile()) return null;
        } catch {
          return null;
        }

        const token = drops.stage(source);

        return token ? { token, name: basename(source) } : null;
      });

      const rememberDirectory = async (source: string) => {
        importDirectory = dirname(source);
        await writeFile(preferencesPath, JSON.stringify({ directory: importDirectory }), {
          mode: 0o600,
        }).catch(() => undefined);
      };

      const shellHandlers = ReviewShellRpc.toLayer(
        Effect.gen(function* () {
          const { api } = yield* BackendApi;

          return {
            CopyPacketReviewDiagnostics: ({ projectId, reviewId }) =>
              api.GetPacketReview({ projectId, reviewId }).pipe(
                Effect.mapError(
                  () =>
                    new ReviewStorageError({ message: "The saved review could not be loaded." }),
                ),
                Effect.flatMap((review) =>
                  Effect.tryPromise({
                    try: () =>
                      clipboard.writeText(
                        JSON.stringify(
                          {
                            reviewId: review.id,
                            model: review.model,
                            state: review.state,
                            error: review.error,
                            providerFailure: review.providerFailure ?? null,
                            preset: review.preset ?? null,
                            admittedCalls: review.admittedCalls,
                            openedSheets: review.inspectedSheetIds.length,
                            // Target: at least 90% of prompt tokens served from the provider cache.
                            promptCache: {
                              cachedShare: cachedPromptShare(review.promptUsage),
                              ...review.promptUsage,
                              sheets: (review.parallel?.sheets ?? []).map((entry) => ({
                                sheetId: entry.sheetId,
                                label:
                                  review.sheets.find((sheet) => sheet.id === entry.sheetId)
                                    ?.label ?? "",
                                cachedShare: cachedPromptShare(entry.promptUsage),
                                calls: entry.promptUsage?.calls ?? 0,
                              })),
                            },
                          },
                          null,
                          2,
                        ),
                      ),
                    catch: () =>
                      new ReviewStorageError({
                        message: "The review diagnostics could not be copied.",
                      }),
                  }),
                ),
              ),
            OpenReviewSource: ({ url }) =>
              Effect.tryPromise({
                try: () => shell.openExternal(url),
                catch: () =>
                  new ReviewStorageError({ message: "The source could not open in your browser." }),
              }),
            ChoosePacketReport: ({ projectId, reviewId }) =>
              Effect.tryPromise({
                try: () =>
                  dialog.showSaveDialog({
                    title: "Save MOKE review report",
                    defaultPath: "MOKE-review.html",
                    filters: [{ name: "HTML report", extensions: ["html"] }],
                  }),
                catch: () =>
                  new ReviewStorageError({ message: "The report chooser could not open." }),
              }).pipe(
                Effect.flatMap((result) =>
                  result.canceled || !result.filePath
                    ? Effect.succeed(false)
                    : api
                        .ExportPacketReport({ projectId, reviewId, destination: result.filePath })
                        .pipe(
                          Effect.as(true),
                          Effect.mapError(
                            () =>
                              new ReviewStorageError({
                                message:
                                  "The report could not be saved. Choose a new filename and try again.",
                              }),
                          ),
                        ),
                ),
              ),
            ChooseReviewPdf: (request) =>
              Effect.gen(function* () {
                const drop = request.dropToken
                  ? yield* drops.claim(request, request.dropToken)
                  : undefined;

                if (drop?.receipt) return drop.receipt;

                const source = yield* Effect.tryPromise({
                  try: async () => {
                    if (drop) return drop.source;

                    const options: Electron.OpenDialogOptions = {
                      title: "Import drawing PDF",
                      properties: ["openFile"],
                      filters: [{ name: "Drawing PDF", extensions: ["pdf"] }],
                    };

                    if (importDirectory) options.defaultPath = importDirectory;
                    const selection = await dialog.showOpenDialog(options);

                    return selection.canceled ? undefined : selection.filePaths[0];
                  },
                  catch: () =>
                    new ReviewStorageError({ message: "The drawing chooser could not open." }),
                });

                if (!source) {
                  if (request.dropToken)
                    return yield* new ReviewStorageError({
                      message: "This dropped file expired. Drop the PDF again.",
                    });

                  return null;
                }

                const receipt = yield* api
                  .ImportReviewPdf({
                    projectId: request.projectId,
                    expectedVersion: request.expectedVersion,
                    commandId: request.commandId,
                    source,
                    name: request.revisionLabel ?? basename(source),
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ReviewStorageError({
                          message: Schema.is(ReviewError)(cause)
                            ? cause.message
                            : "The PDF could not be imported. Try again or choose another PDF.",
                        }),
                    ),
                  );

                drop?.complete(receipt);
                yield* Effect.promise(() => rememberDirectory(source));

                return receipt;
              }),
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
                    `MOKE-review-${new Date().toISOString().replaceAll(":", "-")}`,
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
              Effect.gen(function* () {
                const selection = yield* Effect.tryPromise({
                  try: () =>
                    dialog.showOpenDialog({
                      title: "Choose a complete MOKE review package",
                      properties: ["openDirectory"],
                    }),
                  catch: () =>
                    new ReviewStorageError({ message: "The restore chooser could not open." }),
                });

                const source = selection.filePaths[0];

                if (selection.canceled || source === undefined) return false;
                yield* api.ValidateReviewPackage({ source }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ReviewStorageError({
                        message: `This folder is not a valid review package. ${cause.message} Choose another folder. Your workspace has not changed.`,
                      }),
                  ),
                );

                const confirmation = yield* Effect.tryPromise({
                  try: () =>
                    dialog.showMessageBox({
                      type: "warning",
                      buttons: ["Cancel", "Restore complete package"],
                      defaultId: 0,
                      cancelId: 0,
                      message: "Replace local projects with this package?",
                      detail:
                        "A complete pre-restore package is retained. Restored reviews open as non-executing history. The app restarts after restore.",
                    }),
                  catch: () =>
                    new ReviewStorageError({ message: "The restore confirmation could not open." }),
                });

                if (confirmation.response !== 1) return false;
                yield* api.RestoreReviewPackage({ source }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ReviewStorageError({
                        message:
                          cause.reason === "interrupted"
                            ? "The package replacement was interrupted. Reopen the application to recover before continuing."
                            : `The package was not restored. ${cause.message}`,
                      }),
                  ),
                );
                app.relaunch();
                app.quit();

                return true;
              }),
          };
        }),
      );

      const server = MainRpcServer.layer(ReviewDesktopRpc, {
        authorize: ({ frame }) =>
          frame !== null && frame !== undefined && frame.parent === null && trusted(frame.url),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(ReviewProxy, ExecutionProxy, PacketProxy, CloudReviewProxy, shellHandlers),
        ),
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
        // The renderer is dark only; match native chrome and the first paint to it.
        nativeTheme.themeSource = "dark";

        const window = new BrowserWindow({
          width: 1100,
          height: 760,
          backgroundColor: "#0b0b0c",
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
                                      `MOKE-review-${new Date().toISOString().replaceAll(":", "-")}`,
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
      // Closing the windows disconnects renderer streams before the RPC runtime drains.
      app.on("will-quit", (event) => {
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
