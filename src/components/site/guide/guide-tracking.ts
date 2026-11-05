import type { GuideEventData, GuideEventName } from "./guide-contract";

export function trackGuide(event: GuideEventName, data: GuideEventData = {}): void {
  if (typeof window === "undefined") return;
  if (navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
  const payload = { event, ...data };
  // Observable locally for diagnostics/testing; no identifiers or free text.
  window.dispatchEvent(new CustomEvent("connectlive:guide", { detail: payload }));
  void fetch("/api/public/guide/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), credentials: "same-origin", keepalive: true,
  }).catch(() => { /* Tracking must never interrupt a conversation. */ });
}
