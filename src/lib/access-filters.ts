import type { Device, Session, Presence } from "@/lib/console-types";
import { isUpdateAvailable, normalizePlatform, releaseProductFor } from "@/shared/platform";

/** Access workspace device groups (mirrors the reference sidebar). */
export const ACCESS_GROUPS = [
  { id: "company", label: "All devices by company" },
  { id: "os", label: "All devices by OS" },
  { id: "online", label: "Online" },
  { id: "updates", label: "Outdated agents" },
  { id: "connected", label: "In a session" },
  { id: "recent", label: "Recently accessed" },
  { id: "offline", label: "Offline" },
  { id: "stopped", label: "Agent stopped" },
] as const;
export type AccessGroupId = (typeof ACCESS_GROUPS)[number]["id"];

export const UNASSIGNED_COMPANY = "Unassigned";
export const COMPANY_UNAVAILABLE = "Company unavailable";
/** Sessions the console loads; Recent group only sees this window. */
export const RECENT_SESSION_WINDOW = 50;
export const RECENT_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

export type LatestVersions = { agent: string | null; android: string | null };

export interface AccessContext {
  presenceOf: (d: Device) => Presence;
  sessions: Session[];
  latestVersions: LatestVersions;
  /** license id -> company name (RLS-visible only). */
  companies: Record<string, string | null | undefined>;
  /** False while licenses are loading or failed; licensed devices then read "Company unavailable". */
  companiesLoaded?: boolean;
  now: number;
}

export function agentVersionOf(d: Device): string | undefined {
  const v = (d.metadata as { agent_version?: unknown } | null)?.agent_version;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function hasDeviceUpdate(d: Device, latest: LatestVersions): boolean {
  return isUpdateAvailable(agentVersionOf(d), latest[releaseProductFor(normalizePlatform(d.platform))]);
}

export function companyLabel(d: Device, companies: AccessContext["companies"], loaded = true): string {
  if (!d.license_id) return UNASSIGNED_COMPANY;
  if (!loaded || !(d.license_id in companies)) return COMPANY_UNAVAILABLE;
  return companies[d.license_id]?.trim() || UNASSIGNED_COMPANY;
}

export function osLabel(d: Device): string {
  return normalizePlatform(d.platform) === "android" ? "Android" : "Windows";
}

export function hasLiveSession(d: Device, sessions: Session[]): boolean {
  return sessions.some((s) => s.device_id === d.id && (s.state === "active" || s.state === "paused"));
}

export function isRecentlyAccessed(d: Device, sessions: Session[], now: number, windowMs = RECENT_ACCESS_MS): boolean {
  return sessions.some((s) => {
    if (s.device_id !== d.id) return false;
    const t = Date.parse(s.created_at);
    if (!Number.isFinite(t)) return false;
    const age = now - t;
    return age >= -60_000 && age <= windowMs; // tolerate 1 min clock skew, reject future rows
  });
}

export function deviceMatchesSearch(d: Device, query: string, companies: AccessContext["companies"] = {}, companiesLoaded = true): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.display_name, d.hostname, d.os, osLabel(d), agentVersionOf(d), companyLabel(d, companies, companiesLoaded), d.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

export function deviceInGroup(d: Device, group: AccessGroupId, ctx: AccessContext): boolean {
  switch (group) {
    case "company":
    case "os":
      return true;
    case "online":
      return ctx.presenceOf(d) === "online";
    case "updates":
      return hasDeviceUpdate(d, ctx.latestVersions);
    case "connected":
      return hasLiveSession(d, ctx.sessions);
    case "recent":
      return isRecentlyAccessed(d, ctx.sessions, ctx.now);
    case "offline":
      return ctx.presenceOf(d) === "offline";
    case "stopped":
      return ctx.presenceOf(d) === "stopped";
  }
}

export function countAccessGroups(devices: Device[], ctx: AccessContext): Record<AccessGroupId, number> {
  const out = {} as Record<AccessGroupId, number>;
  for (const g of ACCESS_GROUPS) out[g.id] = devices.filter((d) => deviceInGroup(d, g.id, ctx)).length;
  return out;
}

export function filterAccessDevices(devices: Device[], group: AccessGroupId, query: string, ctx: AccessContext): Device[] {
  return devices.filter((d) => deviceInGroup(d, group, ctx) && deviceMatchesSearch(d, query, ctx.companies, ctx.companiesLoaded ?? true));
}

/** Section buckets for company / OS views; other groups return one unlabeled bucket. */
export function sectionAccessDevices(devices: Device[], group: AccessGroupId, ctx: AccessContext): { label: string | null; devices: Device[] }[] {
  if (group !== "company" && group !== "os") return [{ label: null, devices }];
  const keyOf = group === "company" ? (d: Device) => companyLabel(d, ctx.companies, ctx.companiesLoaded ?? true) : osLabel;
  const map = new Map<string, Device[]>();
  for (const d of devices) {
    const k = keyOf(d);
    map.set(k, [...(map.get(k) ?? []), d]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      const rank = (x: string) => (x === COMPANY_UNAVAILABLE ? 2 : x === UNASSIGNED_COMPANY ? 1 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    })
    .map(([label, list]) => ({ label, devices: list }));
}

/** Connect is only offered when an Agent is reachable (online or reconnecting). */
export function isConnectablePresence(p: Presence): boolean {
  return p === "online" || p === "reconnecting";
}

export function notConnectableReason(p: Presence): string | null {
  if (p === "stopped") return "Agent is stopped on this device; an admin can relaunch it from More";
  if (p === "offline") return "Device is offline";
  return null;
}

/** Drop selected ids that are not visible in the current view. Returns same Set if unchanged. */
export function pruneSelection(selected: Set<string>, visibleIds: Iterable<string>): Set<string> {
  const vis = new Set(visibleIds);
  if ([...selected].every((id) => vis.has(id))) return selected;
  return new Set([...selected].filter((id) => vis.has(id)));
}
