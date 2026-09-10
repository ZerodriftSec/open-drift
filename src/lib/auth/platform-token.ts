import { timingSafeEqual } from "node:crypto";

export function isPlatformTokenAuthorized(
  authorization: string | null,
  configuredToken = process.env.PLATFORM_TOKEN,
) {
  const expected = configuredToken?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1]?.trim();

  if (!expected || !provided) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);

  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
