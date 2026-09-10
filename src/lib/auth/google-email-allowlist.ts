import { z } from "zod";

const normalizedEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

export function parseGoogleEmailAllowlist(value: string | undefined) {
  const emails = value
    ?.split(",")
    .map((email) => email.trim())
    .filter(Boolean);

  if (!emails?.length) {
    return new Set<string>();
  }

  return new Set(z.array(normalizedEmailSchema).parse(emails));
}

export function isGoogleEmailAllowed(
  email: string | null | undefined,
  configuredAllowlist = process.env.AUTH_GOOGLE_ALLOWED_EMAILS,
) {
  const parsedEmail = normalizedEmailSchema.safeParse(email);
  if (!parsedEmail.success) {
    return false;
  }

  return parseGoogleEmailAllowlist(configuredAllowlist).has(parsedEmail.data);
}
