import { app, BrowserWindow, dialog, Menu, net, protocol } from "electron";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { MainRpcServer } from "electron-effect-rpc/main";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NotesRpc } from "../src/lib/notes.ts";
import { BackendApi } from "./backend.ts";
import { NotesProxy } from "./notes-proxy.ts";

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

      const backend = BackendApi.layer({
        command: app.isPackaged
          ? [join(process.resourcesPath, "backend", executable)]
          : ["bun", "--no-orphans", join(root, "backend/main.ts")],
        dataDirectory,
        migrationDirectory,
        onUnexpectedExit: () => {
          dialog.showErrorBox(
            "Backend stopped",
            "The application service stopped unexpectedly. Please reopen the app.",
          );
          app.quit();
        },
      });

      const server = MainRpcServer.layer(NotesRpc, {
        authorize: ({ frame }) =>
          frame !== null && frame !== undefined && frame.parent === null && trusted(frame.url),
      }).pipe(Layer.provide(NotesProxy), Layer.provideMerge(backend), Layer.provide(logging));

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
                label: "Export database…",
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
