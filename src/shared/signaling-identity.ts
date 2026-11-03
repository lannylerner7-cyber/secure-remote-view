/** Shared with the native SignalIdentity contract; this is routing, not auth. */
export function isAdminClientId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 64 &&
    !/[^A-Za-z0-9._:-]/.test(value);
}

export function getWebClientId(): string {
  try {
    const existing = localStorage.getItem("connectlive.web_client_id");
    if (isAdminClientId(existing)) return existing;
    const fresh = "web-" + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem("connectlive.web_client_id", fresh);
    return fresh;
  } catch {
    return "web-eph-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
