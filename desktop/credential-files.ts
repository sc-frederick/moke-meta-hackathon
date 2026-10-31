import { Redacted, Schema } from "effect";
import { open } from "node:fs/promises";
import { InferenceConfiguration } from "../src/lib/backend-rpc.ts";
import { reviewModels } from "../src/lib/review/models.ts";

/** A configuration-file failure that never includes its contents or private path. */
export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  message: Schema.String,
}) {}

/** Parse only the two explicitly selected, canonical provider routes. */
export function parseProviderConfiguration(text: string) {
  try {
    const config = Schema.decodeUnknownSync(Schema.fromJsonString(InferenceConfiguration))(text);

    const endpoint =
      config.provider === "meta" ? "https://api.meta.ai/v1" : "https://inference.baseten.co/v1";

    if (
      config.baseUrl.replace(/\/+$/, "") !== endpoint ||
      !reviewModels.some(
        (model) => model.id === config.model && model.provider === config.provider,
      ) ||
      Redacted.value(config.apiKey).length > 4096
    )
      throw new Error("Invalid route");

    // Local and cloud reviews compare routes exactly, so keep only the canonical form.
    return { ...config, baseUrl: endpoint };
  } catch {
    throw new CredentialError({
      message: "The selected credential configuration is invalid for the supported provider route.",
    });
  }
}

/** Read through one handle; Unix session files must be private to their owner. Windows uses ACLs. */
async function readCredentialText(source: string, requirePrivatePermissions: boolean) {
  try {
    const file = await open(source, "r");

    try {
      const info = await file.stat();

      if (!info.isFile() || info.size > 16384)
        throw new CredentialError({
          message: "Choose a regular provider configuration file smaller than 16 KiB.",
        });

      if (requirePrivatePermissions && process.platform !== "win32" && (info.mode & 0o077) !== 0)
        throw new CredentialError({
          message:
            "The session credential file must be readable only by its owner. Set its permissions to 600 and reopen the app.",
        });
      const text = await file.readFile("utf8");

      if (Buffer.byteLength(text) > 16384)
        throw new CredentialError({ message: "The credential configuration is too large." });

      return text;
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof CredentialError) throw cause;
    throw new CredentialError({ message: "The provider credential file could not be read." });
  }
}

/** Read a legacy single-provider credential through the same private-file boundary. */
export async function readProviderConfiguration(source: string, requirePrivatePermissions = false) {
  return parseProviderConfiguration(await readCredentialText(source, requirePrivatePermissions));
}

/** Accept a single configuration or an explicit set of provider credentials. */
export function parseProviderConfigurations(text: string) {
  try {
    const config = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Union([
          InferenceConfiguration,
          Schema.Struct({ providers: Schema.NonEmptyArray(InferenceConfiguration) }),
        ]),
      ),
    )(text);

    const providers = "providers" in config ? config.providers : [config];

    return providers.map((provider) =>
      parseProviderConfiguration(
        JSON.stringify(Schema.encodeSync(InferenceConfiguration)(provider)),
      ),
    );
  } catch {
    throw new CredentialError({
      message: "The selected credential configuration is invalid for the supported provider route.",
    });
  }
}

/** Provider sets retain the owner-only permission requirement for session credentials. */
export async function readProviderConfigurations(
  source: string,
  requirePrivatePermissions = false,
) {
  return parseProviderConfigurations(await readCredentialText(source, requirePrivatePermissions));
}
