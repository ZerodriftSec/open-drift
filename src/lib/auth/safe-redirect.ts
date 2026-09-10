const fallbackRedirectPath = "/sessions";
const localOrigin = "http://localhost";

export function safeRedirectPath(value: string | undefined) {
  if (!value) {
    return fallbackRedirectPath;
  }

  try {
    const url = new URL(value, localOrigin);
    if (url.origin !== localOrigin) {
      return fallbackRedirectPath;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallbackRedirectPath;
  }
}
