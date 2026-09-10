export function appendQueryString(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function sessionsPagePath() {
  return "/sessions";
}

export function sessionPagePath(sessionId: string) {
  return `${sessionsPagePath()}/${encodeURIComponent(sessionId)}`;
}
