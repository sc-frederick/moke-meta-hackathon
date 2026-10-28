import { safeStorage } from "electron";
import { Schema } from "effect";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceConfiguration } from "../src/lib/backend-rpc.ts";
import {
  CredentialError,
  parseProviderConfiguration,
  readProviderConfiguration,
} from "./credential-files.ts";

const StoredCredential = Schema.Struct({
  version: Schema.Literal(1),
  encrypted: Schema.NonEmptyString,
});

const secureStorageAvailable = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");

/** Packaged launches use OS-encrypted storage or an explicitly selected session-only file. */
export async function readInferenceConfiguration(directory: string, packaged: boolean) {
  const sessionFile = process.env.MOKE_SESSION_CREDENTIAL_FILE;

  if (sessionFile !== undefined) return readProviderConfiguration(sessionFile, true);
  const storedFile = join(directory, "provider-credential.json");

  if (existsSync(storedFile)) {
    if (!secureStorageAvailable())
      throw new CredentialError({
        message:
          "Secure credential storage is unavailable. Select a session-only credential configuration.",
      });

    try {
      const stored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredCredential))(
        await readFile(storedFile, "utf8"),
      );

      return parseProviderConfiguration(
        safeStorage.decryptString(Buffer.from(stored.encrypted, "base64")),
      );
    } catch {
      throw new CredentialError({
        message: "The saved provider credential could not be unlocked.",
      });
    }
  }

  if (packaged) return undefined;
  const provider = process.env.MOKE_PROVIDER === "baseten" ? "baseten" : "meta";
  const key = provider === "meta" ? process.env.MODEL_API_KEY : process.env.BASETEN_API_KEY;

  if (!key?.trim()) return undefined;

  return parseProviderConfiguration(
    JSON.stringify({
      provider,
      apiKey: key,
      baseUrl: provider === "meta" ? "https://api.meta.ai/v1" : "https://inference.baseten.co/v1",
      model: provider === "meta" ? "muse-spark-1.3" : "meta-models/muse-spark-open-1026",
    }),
  );
}

/** A shell-selected configuration is encrypted before saving, and never enters renderer RPC. */
export async function storeInferenceConfiguration(directory: string, source: string) {
  const config = await readProviderConfiguration(source);

  if (!secureStorageAvailable())
    throw new CredentialError({
      message:
        "OS credential encryption is unavailable. Use an explicitly selected session-only configuration.",
    });

  const encrypted = safeStorage
    .encryptString(JSON.stringify(Schema.encodeSync(InferenceConfiguration)(config)))
    .toString("base64");

  await writeFile(
    join(directory, "provider-credential.json"),
    JSON.stringify({ version: 1, encrypted }),
    { mode: 0o600, flush: true },
  );
}
