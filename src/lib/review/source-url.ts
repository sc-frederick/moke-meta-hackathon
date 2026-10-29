import { Schema } from "effect";

/** Only credential-free HTTPS sources may leave the trusted review window. */
export const ReviewSourceUrl = Schema.String.check(
  Schema.isMaxLength(2081),
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);

      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }),
);
