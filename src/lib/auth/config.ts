export function isAuthenticationRequired(
  configuredValue = process.env.AUTH_REQUIRED,
): boolean {
  return configuredValue?.trim().toLowerCase() === "true";
}
