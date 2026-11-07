import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  MonitorSmartphone,
  MoreHorizontal,
  Plug,
  Plus,
  Power,
  Search,
  X,
  Download,
  ListChecks,
  RotateCw,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Device, Session, Presence } from "@/lib/console-types";
import { isPowerKindAllowed, normalizePlatform, type PowerKind } from "@/shared/platform";
import {
  ACCESS_GROUPS,
  type AccessGroupId,
  type AccessContext,
  type LatestVersions,
  RECENT_SESSION_WINDOW,
  agentVersionOf,
  companyLabel,
  countAccessGroups,
  filterAccessDevices,
  hasDeviceUpdate,
  hasLiveSession,
  isConnectablePresence,
  notConnectableReason,
  osLabel,
  pruneSelection,
  sectionAccessDevices,
} from "@/lib/access-filters";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Existing authorized Agent download flow: licence sign-in, then portal downloads. */
const INSTALLER_URL = "/public/agent/login";

const POWER_ITEMS: { kind: PowerKind; label: string; admin?: boolean; tone?: string }[] = [
  { kind: "lock", label: "Lock" },
  { kind: "logoff", label: "Sign out user" },
  { kind: "restart_app", label: "Restart app" },
  { kind: "reboot", label: "Reboot", admin: true, tone: "text-amber-200" },
  { kind: "shutdown", label: "Shut down", admin: true, tone: "text-rose-300" },
];

const menuCls = "min-w-52 max-w-[calc(100vw-16px)] border-white/10 bg-[#0F172A] text-white shadow-2xl";
const itemCls = "cursor-pointer text-xs focus:bg-[#4F7CFF]/20 focus:text-white data-[disabled]:opacity-40";
const toolBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-[#7FA0FF] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

function presenceStyle(p: Presence) {
  return p === "online"
    ? { pill: "bg-emerald-400/10 text-emerald-300", dot: "bg-emerald-400" }
    : p === "reconnecting"
      ? { pill: "bg-amber-400/10 text-amber-200", dot: "bg-amber-400 animate-pulse" }
      : p === "stopped"
        ? { pill: "bg-rose-400/10 text-rose-300", dot: "bg-rose-400" }
        : { pill: "bg-white/5 text-white/50", dot: "bg-white/35" };
}

function relTime(iso: string | null, now: number) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function AccessWorkspace(props: {
  devices: Device[];
  sessions: Session[];
  latestVersions: LatestVersions;
  presenceOf: (d: Device) => Presence;
  now: number;
  loading: boolean;
  /** Set when the latest devices fetch failed; list may still hold the previous good snapshot. */
  loadError: string | null;
  onRetry: () => void;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  canConnect: boolean;
  canPower: boolean;
  canShutdown: boolean;
  canDelete: boolean;
  canRelaunch: boolean;
  canPair: boolean;
  relaunching: boolean;
  lifecycleError: string | null;
  lifecycleStatus: (d: Device) => string;
  onConnect: (d: Device) => void;
  onPower: (d: Device, kind: PowerKind) => void;
  onDelete: (d: Device) => void;
  onWindowsUnlock: (d: Device) => void;
  onBulkEnd: () => void;
  onBulkRestart: () => void;
  onPair: () => void;
  onOpenExpected: () => void;
}) {
  const { devices, sessions, latestVersions, presenceOf, now, selected, setSelected } = props;
  const [group, setGroup] = useState<AccessGroupId>("company");
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState<Record<string, string | null>>({});
  const [companyState, setCompanyState] = useState<"loading" | "ok" | "error">("loading");
  const [companyAttempt, setCompanyAttempt] = useState(0);
  const licenseKey = [...new Set(devices.map((d) => d.license_id).filter(Boolean))].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    if (!licenseKey) {
      setCompanyState("ok");
      return;
    }
    setCompanyState((s) => (s === "ok" ? "ok" : "loading"));
    supabase
      .from("licenses")
      .select("id, company")
      .in("id", licenseKey.split(","))
      .then(
        ({ data, error }) => {
          if (cancelled) return;
          if (error) setCompanyState("error");
          else {
            setCompanies(Object.fromEntries((data ?? []).map((r) => [r.id, r.company])));
            setCompanyState("ok");
          }
        },
        () => {
          if (!cancelled) setCompanyState("error");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [licenseKey, companyAttempt]);

  const ctx: AccessContext = { presenceOf, sessions, latestVersions, companies, companiesLoaded: companyState === "ok", now };
  const counts = countAccessGroups(devices, ctx);
  const visible = filterAccessDevices(devices, group, query, ctx);
  const sections = sectionAccessDevices(visible, group, ctx);
  const visibleKey = visible.map((d) => d.id).join(",");

  // Never let selection target devices hidden by group/search.
  useEffect(() => {
    const next = pruneSelection(selected, visibleKey ? visibleKey.split(",") : []);
    if (next !== selected) setSelected(next);
  }, [visibleKey, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupLabel = ACCESS_GROUPS.find((g) => g.id === group)!.label;
  const selDevices = useMemo(() => visible.filter((d) => selected.has(d.id)), [visible, selected]);
  const single = selDevices.length === 1 ? selDevices[0] : null;
  const singlePresence = single ? presenceOf(single) : null;
  const singlePlatform = single ? normalizePlatform(single.platform) : null;
  const allChecked = visible.length > 0 && selDevices.length === visible.length;

  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  const connectReason = !props.canConnect
    ? "Your role cannot start sessions"
    : !single
      ? "Select exactly one device"
      : !isConnectablePresence(singlePresence!)
        ? notConnectableReason(singlePresence!)
        : null;
  const powerReason = !props.canPower
    ? "Your role cannot send power commands"
    : !single
      ? "Select exactly one device"
      : null;
  const bulkReason = !props.canConnect ? "Your role cannot end sessions" : selDevices.length === 0 ? "Select devices first" : null;
  const relaunchReason = !props.canRelaunch
    ? "Admins only"
    : props.lifecycleError
      ? "Recovery status unavailable"
      : props.relaunching
        ? "Request in progress"
        : selDevices.length === 0
          ? "Select devices first"
          : null;
  const deleteReason = !props.canDelete ? "Admins only" : !single ? "Select exactly one device" : null;

  const hint = connectReason && props.canConnect && selDevices.length === 0
    ? "Select a device to connect, send power commands or recover its Agent."
    : selDevices.length > 1
      ? `${selDevices.length} selected. Bulk actions are under More.`
      : single
        ? `${single.display_name} selected · ${singlePresence}`
        : connectReason ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Group sidebar */}
      <aside
        aria-label="Device groups"
        className="flex shrink-0 flex-col border-b border-white/10 bg-gradient-to-b from-[#13203D] to-[#0F172A] md:w-60 md:border-b-0 md:border-r xl:w-72"
      >
        <div className="px-4 pt-4 md:px-5 md:pt-5">
          <h1 className="text-xl font-semibold tracking-tight">Access</h1>
          <p className="mt-1 text-xs text-white/60">Pair an agent and connect to authorized devices.</p>
          <button
            type="button"
            onClick={props.onPair}
            disabled={!props.canPair}
            title={props.canPair ? "Pair a new device" : "Your role cannot pair devices"}
            data-testid="button-pair-device"
            className="mt-4 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-[#4F7CFF] text-sm font-semibold text-white shadow-[0_6px_20px_-8px_#4F7CFF] transition hover:bg-[#6189FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9CCFF] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Pair device <Plus className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <nav className="mt-4 grid grid-cols-2 gap-1 px-3 pb-3 md:block md:space-y-0.5 md:overflow-visible md:px-3">
          {ACCESS_GROUPS.map((g) => {
            const active = g.id === group;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setGroup(g.id)}
                aria-current={active ? "true" : undefined}
                data-testid={`button-group-${g.id}`}
                className={`flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-2 md:gap-4 md:px-3 text-left text-[13px] transition focus-visible:outline-2 focus-visible:outline-[#7FA0FF] md:w-full ${
                  active
                    ? "bg-[#4F7CFF]/20 font-medium text-white shadow-[inset_2px_0_0_#4F7CFF]"
                    : "text-white/65 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span className="min-w-0 truncate md:whitespace-nowrap" title={g.label}>{g.label}</span>
                <span className={`font-mono text-xs tabular-nums ${active ? "text-[#B9CCFF]" : "text-white/40"}`}>
                  {counts[g.id]}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden space-y-2 p-4 md:block">
          {companyState === "error" && (
            <p role="status" className="text-[11px] leading-relaxed text-white/55">
              Company names could not be loaded.{" "}
              <button type="button" onClick={() => setCompanyAttempt((n) => n + 1)} className="underline underline-offset-2 hover:text-white">
                Retry
              </button>
            </p>
          )}
          <button
            type="button"
            onClick={props.onOpenExpected}
            data-testid="button-open-expected"
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-white/20 text-xs font-medium text-white/85 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-[#7FA0FF]"
          >
            <ListChecks className="h-3.5 w-3.5" aria-hidden /> Expected devices
          </button>
          <a
            href={INSTALLER_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md text-xs text-white/60 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-[#7FA0FF]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden /> Agent downloads
          </a>
        </div>
      </aside>

      {/* Device workspace */}
      <section aria-label={groupLabel} className="flex min-w-0 flex-1 flex-col bg-[#0B1220]">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/10 px-4 py-3 md:px-5">
          <h2 className="truncate text-lg font-semibold" data-testid="text-group-title">{groupLabel}</h2>
          <div role="toolbar" aria-label="Device actions" className="flex items-center gap-0.5">
            <button
              type="button"
              className={toolBtn}
              disabled={!!connectReason}
              title={connectReason ?? `Connect to ${single?.display_name}`}
              onClick={() => single && props.onConnect(single)}
              data-testid="button-toolbar-connect"
            >
              <Plug className="h-4 w-4" aria-hidden /> Connect
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={!!powerReason}>
                <button type="button" className={toolBtn} title={powerReason ?? "Power actions"} data-testid="button-toolbar-power">
                  <Power className="h-4 w-4" aria-hidden /> Power <ChevronDown className="h-3 w-3" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              {single && singlePlatform && (
                <DropdownMenuContent align="end" collisionPadding={8} className={menuCls}>
                  <DropdownMenuLabel className="text-[11px] text-white/50">{single.display_name}</DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-white/10" />
                  {singlePlatform === "windows" && (
                    <DropdownMenuItem
                      className={itemCls}
                      disabled={singlePresence === "online"}
                      onSelect={() => props.onPower(single, "wake")}
                    >
                      Wake on LAN{singlePresence === "online" ? " (already online)" : ""}
                    </DropdownMenuItem>
                  )}
                  {POWER_ITEMS.filter((i) => isPowerKindAllowed(singlePlatform, i.kind)).map((i) => {
                    const why = i.admin && !props.canShutdown ? "admins only" : singlePresence !== "online" ? "device not online" : null;
                    return (
                      <DropdownMenuItem
                        key={i.kind}
                        className={`${itemCls} ${i.tone ?? ""}`}
                        disabled={!!why}
                        onSelect={() => props.onPower(single, i.kind)}
                      >
                        {i.label}
                        {why && <span className="ml-auto pl-3 text-[10px] text-white/45">{why}</span>}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              )}
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={toolBtn} aria-label="More actions" data-testid="button-toolbar-more">
                  <MoreHorizontal className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">More</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" collisionPadding={8} className={menuCls}>
                <DropdownMenuItem className={itemCls}
                  disabled={!props.canDelete || !single || single.platform !== "windows"}
                  onSelect={() => single && props.onWindowsUnlock(single)}>
                  Windows lock-screen access
                </DropdownMenuItem>
                <DropdownMenuItem className={itemCls} disabled={!!bulkReason} onSelect={props.onBulkEnd}>
                  End sessions on selected
                  {bulkReason && <span className="ml-auto pl-3 text-[10px] text-white/45">{bulkReason}</span>}
                </DropdownMenuItem>
                <DropdownMenuItem className={itemCls} disabled={!!relaunchReason} onSelect={props.onBulkRestart}>
                  {props.relaunching ? "Requesting recovery..." : "Relaunch Windows Agent"}
                  {relaunchReason && !props.relaunching && <span className="ml-auto pl-3 text-[10px] text-white/45">{relaunchReason}</span>}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={`${itemCls} text-rose-300`}
                  disabled={!!deleteReason}
                  onSelect={() => single && props.onDelete(single)}
                >
                  Remove device
                  {deleteReason && <span className="ml-auto pl-3 text-[10px] text-white/45">{deleteReason}</span>}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem className={itemCls} onSelect={props.onOpenExpected}>Expected devices</DropdownMenuItem>
                <DropdownMenuItem className={itemCls} onSelect={() => window.open(INSTALLER_URL, "_blank", "noopener")}>
                  Agent downloads
                </DropdownMenuItem>
                <DropdownMenuItem className={itemCls} disabled={selected.size === 0} onSelect={() => setSelected(new Set())}>
                  Clear selection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5 md:px-5">
          <input
            type="checkbox"
            aria-label="Select all visible devices"
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = selDevices.length > 0 && !allChecked;
            }}
            disabled={visible.length === 0}
            onChange={() => setSelected(allChecked ? new Set() : new Set(visible.map((d) => d.id)))}
            className="h-4 w-4 shrink-0 accent-[#4F7CFF]"
            data-testid="checkbox-select-all"
          />
          <p className="min-w-0 flex-1 truncate text-xs text-white/55" aria-live="polite">{hint}</p>
          <label className="relative w-40 shrink-0 sm:w-64">
            <span className="sr-only">Search devices</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${groupLabel.toLowerCase()}`}
              className="h-8 w-full rounded-full border border-white/20 bg-white/[0.03] pl-8 pr-8 text-xs text-white placeholder:text-white/40 focus:border-[#4F7CFF] focus:outline-none"
              data-testid="input-device-search"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-white/50 hover:text-white"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
        </div>

        {props.lifecycleError && (
          <p role="alert" className="mx-4 mt-3 rounded border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs text-amber-200 md:mx-5">
            {props.lifecycleError}
          </p>
        )}

        {group === "recent" && (
          <p className="mx-4 mt-3 text-[11px] text-white/50 md:mx-5">
            Based on the latest {RECENT_SESSION_WINDOW} sessions loaded by the console within the last 7 days, not full history.
          </p>
        )}
        {props.loadError && devices.length > 0 && (
          <p role="alert" className="mx-4 mt-3 flex items-center justify-between gap-3 rounded border border-rose-400/30 bg-rose-400/10 p-2.5 text-xs text-rose-200 md:mx-5">
            <span className="min-w-0">Device refresh failed; showing the last loaded list. {props.loadError}</span>
            <button type="button" onClick={props.onRetry} className="inline-flex shrink-0 items-center gap-1 rounded border border-rose-300/40 px-2 py-1 hover:bg-rose-400/10">
              <RotateCw className="h-3 w-3" aria-hidden /> Retry
            </button>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {props.loadError && devices.length === 0 ? (
            <div role="alert" className="flex flex-col items-center px-6 py-16 text-center">
              <p className="text-lg font-medium">Devices could not be loaded</p>
              <p className="mt-1.5 max-w-sm text-sm text-white/55">{props.loadError}</p>
              <button type="button" onClick={props.onRetry} data-testid="button-retry-devices"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-[#4F7CFF] px-4 py-2 text-sm font-medium hover:bg-[#6189FF] focus-visible:outline-2 focus-visible:outline-[#B9CCFF]">
                <RotateCw className="h-4 w-4" aria-hidden /> Retry
              </button>
            </div>
          ) : props.loading ? (
            <ul aria-label="Loading devices" className="space-y-px p-4 md:p-5">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="h-14 animate-pulse rounded bg-white/[0.04]" />
              ))}
            </ul>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <div className="mb-5 grid h-20 w-20 place-items-center rounded-2xl border border-white/10 bg-[#1F2A44]/60">
                <MonitorSmartphone className="h-9 w-9 text-[#7FA0FF]" aria-hidden />
              </div>
              <p className="text-lg font-medium">
                {query ? `No matches for "${query}"` : `"${groupLabel}" is empty`}
              </p>
              <p className="mt-1.5 max-w-sm text-sm text-white/55">
                {query
                  ? "Try a device name, hostname, OS, version or company."
                  : devices.length === 0
                    ? "Choose Pair device to enroll your first authorized device."
                    : "Select a different group, or pair another device."}
              </p>
            </div>
          ) : (
            sections.map((sec) => (
              <div key={sec.label ?? "all"}>
                {sec.label && (
                  <h3 className="sticky top-0 z-[1] border-b border-white/5 bg-[#0B1220]/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#9DB8D6] backdrop-blur md:px-5">
                    {sec.label} <span className="font-mono text-white/40">{sec.devices.length}</span>
                  </h3>
                )}
                <ul>
                  {sec.devices.map((d) => {
                    const p = presenceOf(d);
                    const st = presenceStyle(p);
                    const checked = selected.has(d.id);
                    const v = agentVersionOf(d);
                    return (
                      <li
                        key={d.id}
                        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/5 px-4 py-2.5 transition lg:grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1fr)_6.5rem_auto] md:px-5 ${checked ? "bg-[#4F7CFF]/10" : "hover:bg-white/[0.03]"}`}
                        data-testid={`row-device-${d.id}`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${d.display_name}`}
                          checked={checked}
                          onChange={() => toggle(d.id)}
                          className="h-4 w-4 accent-[#4F7CFF]"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium" title={d.display_name}>{d.display_name}</p>
                          <p className="flex min-w-0 flex-wrap gap-x-2 text-[11px] text-white/50">
                            <span className="max-w-full truncate" title={d.hostname ?? undefined}>{d.hostname ?? "no hostname"}</span>
                            <span>{osLabel(d)}{v ? ` · v${v}` : ""}</span>
                            {hasDeviceUpdate(d, latestVersions) && <span className="text-amber-200">update available</span>}
                            {group !== "company" && <span className="max-w-full truncate text-white/40">{companyLabel(d, companies, companyState === "ok")}</span>}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] lg:hidden">
                            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 ${st.pill}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden />
                              {p}{hasLiveSession(d, sessions) ? " · in session" : ""}
                            </span>
                            <span className="text-white/45">seen {relTime(d.last_seen_at, now)}</span>
                          </p>
                        </div>
                        <div className="hidden min-w-0 lg:block">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${st.pill}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                            {p}
                            {hasLiveSession(d, sessions) && <span className="text-[#B9CCFF]"> · in session</span>}
                          </span>
                          <p className="mt-0.5 truncate text-[10px] text-white/45" title={props.lifecycleStatus(d)}>{props.lifecycleStatus(d)}</p>
                        </div>
                        <span className="hidden text-xs text-white/50 lg:block" title={d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : undefined}>
                          {relTime(d.last_seen_at, now)}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => props.onConnect(d)}
                            disabled={!props.canConnect || !isConnectablePresence(p)}
                            title={!props.canConnect ? "Your role cannot start sessions" : !isConnectablePresence(p) ? notConnectableReason(p) ?? undefined : `Connect to ${d.display_name}`}
                            className="rounded-md bg-[#4F7CFF] px-3 py-1 text-xs font-medium hover:bg-[#6189FF] focus-visible:outline-2 focus-visible:outline-[#B9CCFF] disabled:cursor-not-allowed disabled:opacity-35"
                            data-testid={`button-connect-${d.id}`}
                          >
                            Connect
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
