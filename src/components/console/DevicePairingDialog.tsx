import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createDevicePairing,
  listPairingLicenses,
  revokeDevicePairing,
} from "@/lib/device-pairing.functions";
import {
  PAIRING_CAPABILITY_LABELS,
  type IssuedPairing,
  type PairingCapabilities,
} from "@/shared/device-pairing";

type License = { id: string; organization: string; expiresAt: string; seatLimit: number | null };
type Mode = "attended" | "unattended";
type OptionalCap = Exclude<keyof PairingCapabilities, "view">;

const OPTIONAL_CAPS: OptionalCap[] = ["control", "clipboard", "files", "recording"];
const NO_CAPS: Record<OptionalCap, boolean> = {
  control: false,
  clipboard: false,
  files: false,
  recording: false,
};

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Disclosed enrollment of a Windows device. Issues a real one-time code via
 * authenticated server functions; the issued disclosure is shown read-only
 * from the server response so later form edits cannot contradict it.
 */
export function DevicePairingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listFn = useServerFn(listPairingLicenses);
  const createFn = useServerFn(createDevicePairing);
  const revokeFn = useServerFn(revokeDevicePairing);

  const [licenses, setLicenses] = useState<License[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [licenseId, setLicenseId] = useState<string>("");
  const [mode, setMode] = useState<Mode>("unattended");
  const [caps, setCaps] = useState<Record<OptionalCap, boolean>>(NO_CAPS);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedPairing | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokedNotice, setRevokedNotice] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const createLock = useRef(false);

  const listRef = useRef(listFn);
  listRef.current = listFn;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = (await listRef.current()) as License[];
      setLicenses(rows);
      setLicenseId((prev) => {
        if (prev && rows.some((r) => r.id === prev && r.organization)) return prev;
        return rows.find((r) => r.organization)?.id ?? "";
      });
    } catch (e) {
      setLoadError(errorText(e, "Could not load eligible licenses."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!issued) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [issued]);

  const selected = licenses?.find((l) => l.id === licenseId) ?? null;
  const canCreate = !!selected && !!selected.organization && !creating && !issued;
  const expiresMs = issued ? new Date(issued.expiresAt).getTime() - now : 0;
  const expired = !!issued && expiresMs <= 0;
  const allSelected = OPTIONAL_CAPS.every((c) => caps[c]);

  async function create() {
    if (!selected || !selected.organization || createLock.current) return;
    createLock.current = true;
    setCreating(true);
    setCreateError(null);
    setRevokedNotice(false);
    try {
      const result = await createFn({
        data: {
          licenseId: selected.id,
          grant: { noticeVersion: 1, mode, capabilities: { view: true, ...caps } },
        },
      });
      setNow(Date.now());
      setIssued(result);
    } catch (e) {
      setCreateError(errorText(e, "Could not create a pairing code."));
    } finally {
      createLock.current = false;
      setCreating(false);
    }
  }

  async function revoke() {
    if (!issued || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeFn({ data: { pairingId: issued.id } });
      setIssued(null);
      setRevokedNotice(true);
    } catch (e) {
      setRevokeError(errorText(e, "The pairing code could not be revoked."));
    } finally {
      setRevoking(false);
    }
  }

  function startNew() {
    setIssued(null);
    setRevokeError(null);
    setRevokedNotice(false);
    setCreateError(null);
  }

  async function copyCode() {
    if (!issued) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(issued.code);
      toast.success("Code copied");
    } catch {
      toast.error("Copy failed. Select the code field and copy it manually.");
    }
  }

  const sectionLabel = "text-[11px] font-semibold uppercase tracking-wider text-white/50";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto border-white/10 bg-[#0F172A] text-white">
        <DialogHeader>
          <DialogTitle>Pair a Windows device</DialogTitle>
          <DialogDescription className="text-white/60">
            Issue a one-time code. The person at the device reviews the organization and permissions
            in the Agent before authorizing.
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="space-y-4" data-testid="panel-issued-pairing">
            <div>
              <label htmlFor="pairing-code" className={sectionLabel}>
                One-time code
              </label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id="pairing-code"
                  data-testid="input-pairing-code"
                  readOnly
                  value={issued.code}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-describedby="pairing-expiry"
                  className={`border-white/15 bg-[#0B1220] text-center font-mono text-lg tracking-[0.2em] ${expired ? "text-white/40 line-through" : "text-white"}`}
                />
                <Button
                  type="button"
                  variant="outline"
                  data-testid="button-copy-code"
                  disabled={expired}
                  onClick={() => void copyCode()}
                >
                  Copy
                </Button>
              </div>
              <p
                id="pairing-expiry"
                data-testid="text-pairing-expiry"
                aria-live="polite"
                className={`mt-1.5 text-xs ${expired ? "text-rose-300" : "text-white/60"}`}
              >
                {expired
                  ? "This code has expired and can no longer be used."
                  : `Expires in ${formatRemaining(expiresMs)} (${new Date(issued.expiresAt).toLocaleTimeString()})`}
              </p>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-white/10 bg-[#0B1220] p-3 text-sm">
              <dt className="text-white/50">Organization</dt>
              <dd data-testid="text-issued-organization">{issued.organization}</dd>
              <dt className="text-white/50">Access</dt>
              <dd>{issued.grant.mode === "unattended" ? "Unattended" : "Attended"}</dd>
              <dt className="text-white/50">Permissions</dt>
              <dd>
                <ul className="space-y-0.5" data-testid="list-issued-capabilities">
                  {(Object.keys(PAIRING_CAPABILITY_LABELS) as (keyof PairingCapabilities)[]).map((k) => (
                    <li key={k} className={issued.grant.capabilities[k] ? "" : "text-white/35"}>
                      {issued.grant.capabilities[k] ? "Granted: " : "Not granted: "}
                      {PAIRING_CAPABILITY_LABELS[k]}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>

            <ol className="list-decimal space-y-1 pl-5 text-sm text-white/75">
              <li>On the Windows device, open the ConnectLive Agent.</li>
              <li>Enter this code.</li>
              <li>Review the organization and permissions shown.</li>
              <li>Press Pair &amp; authorize.</li>
            </ol>

            <p className="text-xs text-white/50">
              Revoking this code only stops it from being used. It does not revoke a device that has
              already paired; remove that device from the devices list instead.
            </p>
            {revokeError && (
              <p role="alert" className="text-xs text-rose-300">
                {revokeError}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              {expired ? (
                <Button type="button" data-testid="button-new-code" onClick={startNew}>
                  New code
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  data-testid="button-revoke-code"
                  disabled={revoking}
                  onClick={() => void revoke()}
                >
                  {revoking ? "Revoking..." : "Revoke code"}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
            {!expired && (
              <p className="text-[11px] text-white/40">
                Closing this dialog does not revoke the code; it stays valid until it expires.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {revokedNotice && (
              <p role="status" className="rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                Code revoked. Any device already paired is unaffected.
              </p>
            )}

            <div>
              <div className={sectionLabel}>Organization license</div>
              {loading && !licenses ? (
                <div className="mt-2 space-y-2" aria-busy="true">
                  <div className="h-9 animate-pulse rounded bg-white/5" />
                  <div className="h-9 animate-pulse rounded bg-white/5" />
                </div>
              ) : loadError ? (
                <div role="alert" className="mt-2 flex items-center justify-between gap-3 rounded border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                  <span>{loadError}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                    Retry
                  </Button>
                </div>
              ) : licenses && licenses.length === 0 ? (
                <div className="mt-2 flex items-center justify-between gap-3 rounded border border-white/10 bg-[#0B1220] px-3 py-2 text-xs text-white/60">
                  <span>No active license is eligible for device pairing on this account.</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div role="radiogroup" aria-label="License" className="mt-2 max-h-44 space-y-1.5 overflow-y-auto">
                  {licenses?.map((l) => {
                    const usable = !!l.organization;
                    return (
                      <label
                        key={l.id}
                        className={`flex items-start gap-2 rounded border px-3 py-2 text-sm ${licenseId === l.id ? "border-[#4F7CFF] bg-[#4F7CFF]/10" : "border-white/10"} ${usable ? "cursor-pointer" : "opacity-60"}`}
                      >
                        <input
                          type="radio"
                          name="pairing-license"
                          data-testid={`radio-license-${l.id}`}
                          className="mt-1 accent-[#4F7CFF]"
                          disabled={!usable}
                          checked={licenseId === l.id}
                          onChange={() => setLicenseId(l.id)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{usable ? l.organization : "No organization set"}</span>
                          <span className="block text-[11px] text-white/45">
                            {usable
                              ? `Expires ${new Date(l.expiresAt).toLocaleDateString()}${l.seatLimit != null ? ` · ${l.seatLimit} seats` : ""}`
                              : "Add an organization/account name in license settings before issuing codes."}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <fieldset>
              <legend className={sectionLabel}>Access type</legend>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {(["unattended", "attended"] as const).map((m) => (
                  <label
                    key={m}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm ${mode === m ? "border-[#4F7CFF] bg-[#4F7CFF]/10" : "border-white/10"}`}
                  >
                    <input
                      type="radio"
                      name="pairing-mode"
                      data-testid={`radio-mode-${m}`}
                      className="accent-[#4F7CFF]"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    {m === "unattended" ? "Unattended" : "Attended"}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-white/55">
                {mode === "unattended"
                  ? "Unattended access survives restarts without asking the user at each session. Connection status, stop and revocation remain available to the user on the device at all times."
                  : "The person at the device must approve each session."}
              </p>
            </fieldset>

            <fieldset>
              <div className="flex items-center justify-between">
                <legend className={sectionLabel}>Permissions</legend>
                <button
                  type="button"
                  data-testid="button-select-all-permissions"
                  className="text-xs text-[#9DB8FF] hover:underline disabled:opacity-40"
                  disabled={allSelected}
                  onClick={() => setCaps({ control: true, clipboard: true, files: true, recording: true })}
                >
                  Select all listed permissions
                </button>
              </div>
              <div className="mt-2 space-y-1">
                <label className="flex items-center gap-2 text-sm text-white/60">
                  <input type="checkbox" checked disabled className="accent-[#4F7CFF]" />
                  {PAIRING_CAPABILITY_LABELS.view} (required)
                </label>
                {OPTIONAL_CAPS.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid={`checkbox-cap-${c}`}
                      className="accent-[#4F7CFF]"
                      checked={caps[c]}
                      onChange={(e) => setCaps((p) => ({ ...p, [c]: e.target.checked }))}
                    />
                    {PAIRING_CAPABILITY_LABELS[c]}
                  </label>
                ))}
              </div>
            </fieldset>

            {createError && (
              <p role="alert" className="text-xs text-rose-300">
                {createError}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="button-create-code"
                disabled={!canCreate}
                onClick={() => void create()}
                className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90"
              >
                {creating ? "Creating..." : "Create code"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
