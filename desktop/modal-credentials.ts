import { Effect, Schema } from "effect";
import { open } from "node:fs/promises";
import { ModalConfiguration } from "../src/lib/backend-rpc.ts";
import { CredentialError } from "./credential-files.ts";

/** A private session file works in packaged builds; development can use environment variables. */
export const readModalConfiguration = Effect.fn("readModalConfiguration")(function* (
  packaged: boolean,
) {
  const sessionFile = process.env.MOKE_MODAL_CONFIG;

  if (sessionFile !== undefined) {
    const text = yield* Effect.tryPromise({
      try: async () => {
        const file = await open(sessionFile, "r");

        try {
          const info = await file.stat();

          if (
            !info.isFile() ||
            info.size > 16_384 ||
            (process.platform !== "win32" && (info.mode & 0o077) !== 0)
          )
            throw new CredentialError({
              message:
                "Use a private Modal configuration file (permissions 600), smaller than 16 KiB.",
            });

          return await file.readFile("utf8");
        } finally {
          await file.close();
        }
      },
      catch: () =>
        new CredentialError({
          message:
            "The private Modal configuration file could not be read. Check its permissions and size.",
        }),
    });

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModalConfiguration))(text).pipe(
      Effect.mapError(
        () => new CredentialError({ message: "The Modal session configuration is invalid." }),
      ),
    );
  }

  if (packaged) return undefined;
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;

  if (!tokenId && !tokenSecret) return undefined;

  return yield* Schema.decodeUnknownEffect(ModalConfiguration)({
    tokenId,
    tokenSecret,
    appName: process.env.MOKE_MODAL_APP ?? "moke-reviews",
    environment: process.env.MODAL_ENVIRONMENT ?? "main",
    imageName: process.env.MOKE_MODAL_IMAGE ?? "moke-review-engine:latest",
    timeoutMinutes: Number(process.env.MOKE_MODAL_TIMEOUT_MINUTES ?? "15"),
    poolQueue: process.env.MOKE_MODAL_POOL_QUEUE ?? null,
  }).pipe(
    Effect.mapError(() => new CredentialError({ message: "The Modal configuration is invalid." })),
  );
});
