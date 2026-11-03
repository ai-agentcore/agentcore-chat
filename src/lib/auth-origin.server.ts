/** Keep local OAuth state cookies on the same host as the configured callback. */
export function localAuthRedirect(host: string | null, baseURL: string, production = process.env.NODE_ENV === "production") {
  if (production || !host) return null;
  try {
    const canonical = new URL(baseURL);
    const incoming = new URL(`http://${host}`);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (!loopback.has(canonical.hostname) || !loopback.has(incoming.hostname) || canonical.host === incoming.host) return null;
    return new URL("/login", canonical.origin).href;
  } catch { return null; }
}
