import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getWindowsUnlock, removeWindowsHelloPin, revokeWindowsUnlock, saveWindowsHelloPin,
} from "@/lib/windows-unlock-client";
import { UNLOCK_PIN_NOTICE, validHelloPin, type UnlockDevice } from "@/shared/windows-unlock";

function errorText(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type Busy = null | "save" | "forget" | "revoke";

/**
 * Manage explicitly authorized Windows lock-screen access for one device.
 * The PIN is typed by the operator, sealed for the enrolled Agent key in the
 * browser, and never returned, shown, or persisted client-side.
 */
export function WindowsUnlockSettings({
  deviceId, deviceName, canManage, onClose,
}: { deviceId: string; deviceName: string; canManage: boolean; onClose: () => void }) {
  const [device, setDevice] = useState<UnlockDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  const generation = useRef(0);
  const busyRef = useRef(false);
  const keyRef = useRef<string | null>(null);

  const clearSecrets = useCallback(() => { setPin(""); setConfirmPin(""); setConsent(false); }, []);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    const id = deviceId;
    setLoading(true);
    setLoadError(null);
    try {
      const row = await getWindowsUnlock(id);
      if (gen !== generation.current || deviceRef.current !== id) return;
      if (!row || row.deviceId !== id) throw new Error("The server returned status for a different device.");
      const key = `${row.authorizationId}:${row.keyId}`;
      if (keyRef.current !== null && keyRef.current !== key) clearSecrets();
      keyRef.current = key;
      setDevice(row);
    } catch (e) {
      if (gen !== generation.current || deviceRef.current !== id) return;
      setLoadError(errorText(e, "Windows unlock status is unavailable."));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [deviceId, clearSecrets]);

  // Device change: drop all state including any typed PIN, then reload.
  useEffect(() => {
    clearSecrets();
    setDevice(null);
    setActionError(null);
    setNotice(null);
    setConfirmRevoke(false);
    setConfirmForget(false);
    const interval = window.setInterval(() => {
      if (!busyRef.current) void load();
    }, 10_000);
    void load();
    return () => { generation.current += 1; window.clearInterval(interval); };
  }, [deviceId, load, clearSecrets]);

  // Clear secrets on unmount/close.
  useEffect(() => () => { setPin(""); setConfirmPin(""); }, []);

  function close() { clearSecrets(); onClose(); }

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<UnlockDevice>, ok: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    const id = deviceId;
    const gen = ++generation.current;
    setBusy(kind);
    setActionError(null);
    setNotice(null);
    try {
      const row = await fn();
      if (deviceRef.current !== id || gen !== generation.current) return;
      if (!row || row.deviceId !== id) throw new Error("The server response did not match this device. Reload status.");
      setDevice(row);
      setNotice(ok);
    } catch (e) {
      if (deviceRef.current !== id || gen !== generation.current) return;
      setActionError(errorText(e, "Windows unlock could not complete. No automatic retry was made."));
    } finally {
      busyRef.current = false;
      if (kind === "save") clearSecrets();
      if (deviceRef.current === id) { setBusy(null); setConfirmRevoke(false); setConfirmForget(false); }
    }
  }

  const ready = !!device && device.enabled && !!device.keyId && !!device.publicKey && !!device.authorizationId;
  const pinValid = validHelloPin(pin);
  const matches = pin.length > 0 && pin === confirmPin;
  const canSave = canManage && ready && !loadError && consent && pinValid && matches && !busy;
  const label = "text-[11px] font-semibold uppercase tracking-wider text-white/50";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent
        data-testid="dialog-windows-unlock-settings"
        className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto border-white/10 bg-[#0F172A] text-white"
      >
        <DialogHeader>
          <DialogTitle>Windows lock-screen access</DialogTitle>
          <DialogDescription className="text-white/60">
            <span data-testid="text-unlock-device-name">{deviceName}</span>. Lock-screen access is
            separate from remote view and must be enabled locally on the device.
          </DialogDescription>
        </DialogHeader>

        {loading && !device ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <p className="text-xs text-white/65">Loading Windows unlock status…</p>
            <div className="h-16 animate-pulse rounded bg-white/5" />
            <div className="h-9 animate-pulse rounded bg-white/5" />
          </div>
        ) : loadError && !device ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" data-testid="button-unlock-retry" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : device ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-white/10 bg-[#0B1220] p-3 text-sm" data-testid="list-unlock-status">
              <dt className="text-white/50">Permission</dt>
              <dd data-testid="status-unlock-enabled">{device.enabled ? "Authorized on device" : "Not authorized"}</dd>
              <dt className="text-white/50">Windows account</dt>
              <dd>{device.windowsAccount ?? "Unknown"}</dd>
              <dt className="text-white/50">Agent helper</dt>
              <dd data-testid="status-unlock-helper">{device.helperReady ? "Ready" : "Not ready or offline"}</dd>
              <dt className="text-white/50">Saved PIN</dt>
              <dd data-testid="status-unlock-pin">{device.hasPin ? "Saved (cannot be shown)" : "None"}</dd>
              <dt className="text-white/50">Last seen</dt>
              <dd>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "Never"}</dd>
            </dl>
            {loadError && (
              <p role="alert" className="text-xs text-rose-300">
                Status refresh failed: {loadError}{" "}
                <button type="button" className="text-[#9DB8FF] underline" onClick={() => void load()}>Retry</button>
              </p>
            )}

            {!ready && (
              <div data-testid="panel-unlock-setup" className="rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                <p className="font-medium">Local setup required</p>
                <p className="mt-1 text-amber-100/80">
                  A person with administrator rights on the device must enable it there: run the
                  ConnectLive Agent with <code className="font-mono">--unlock-setup</code> and approve installation of
                   the local unlock service, then run <code className="font-mono">--unlock-enable</code> as the paired
                   Windows user. This creates the device encryption key. It cannot be enabled remotely.
                </p>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void load()} disabled={loading}>
                  {loading ? "Checking..." : "Check again"}
                </Button>
              </div>
            )}

            {!canManage && (
              <p className="text-xs text-white/60">Your role can view this status but cannot change the saved PIN or permission.</p>
            )}

            {ready && canManage && (
              <form
                className="space-y-3"
                autoComplete="off"
                onSubmit={(e) => { e.preventDefault(); if (canSave && device) { const p = pin; void run("save", () => saveWindowsHelloPin(device, p), "PIN encrypted for this Agent and saved. It cannot be shown again."); } }}
              >
                <div className={label}>{device.hasPin ? "Replace saved PIN" : "Save Windows Hello PIN"}</div>
                <p className="rounded border border-white/10 bg-[#0B1220] p-3 text-xs text-white/75" data-testid="text-unlock-notice">{UNLOCK_PIN_NOTICE}</p>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" data-testid="checkbox-unlock-consent" className="mt-1 accent-[#4F7CFF]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  I understand and choose to save a reusable PIN for this device.
                </label>
                <div>
                  <label htmlFor="unlock-pin" className={label}>Windows Hello PIN</label>
                  <Input id="unlock-pin" data-testid="input-unlock-pin" type="password" inputMode="text" autoComplete="new-password"
                    spellCheck={false} autoCorrect="off" autoCapitalize="off" maxLength={127} value={pin}
                    onCopy={e => e.preventDefault()} onCut={e => e.preventDefault()}
                    onChange={(e) => setPin(e.target.value)} aria-describedby="unlock-pin-help"
                    className="mt-1.5 border-white/15 bg-[#0B1220] font-mono text-white" />
                  <p id="unlock-pin-help" className="mt-1 text-[11px] text-white/50">
                    4 to 127 printable characters. Entered exactly as typed; leading zeroes matter and nothing is trimmed.
                  </p>
                </div>
                <div>
                  <label htmlFor="unlock-pin-confirm" className={label}>Confirm PIN</label>
                  <Input id="unlock-pin-confirm" data-testid="input-unlock-pin-confirm" type="password" inputMode="text" autoComplete="new-password"
                    spellCheck={false} autoCorrect="off" autoCapitalize="off" maxLength={127} value={confirmPin}
                    onCopy={e => e.preventDefault()} onCut={e => e.preventDefault()}
                    onChange={(e) => setConfirmPin(e.target.value)}
                    className="mt-1.5 border-white/15 bg-[#0B1220] font-mono text-white" />
                  {pin.length > 0 && !pinValid && <p className="mt-1 text-[11px] text-rose-300">Use 4 to 127 printable ASCII characters.</p>}
                  {confirmPin.length > 0 && !matches && <p className="mt-1 text-[11px] text-rose-300">The entries do not match.</p>}
                </div>
                {!device.helperReady && (
                  <p className="text-[11px] text-white/55">The device appears offline. You can still save to its enrolled key; unlocking requires it online.</p>
                )}
                <Button type="submit" data-testid="button-save-unlock-pin" disabled={!canSave} className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90">
                  {busy === "save" ? "Encrypting and saving..." : device.hasPin ? "Replace PIN" : "Save PIN"}
                </Button>
              </form>
            )}

            {canManage && (device.hasPin || device.enabled) && (
              <div className="space-y-2 border-t border-white/10 pt-3">
                {device.hasPin && (confirmForget ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-white/70">Forget the saved PIN? Lock-screen permission stays.</span>
                    <Button type="button" size="sm" variant="destructive" data-testid="button-confirm-forget-pin" disabled={!!busy}
                      onClick={() => void run("forget", () => removeWindowsHelloPin(deviceId), "Saved PIN removed from active use.")}>
                      {busy === "forget" ? "Forgetting..." : "Forget PIN"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setConfirmForget(false)}>Keep</Button>
                  </div>
                ) : (
                  <Button type="button" size="sm" variant="outline" data-testid="button-forget-pin" disabled={!!busy} onClick={() => { setConfirmRevoke(false); setConfirmForget(true); }}>
                    Forget saved PIN
                  </Button>
                ))}
                {device.enabled && (confirmRevoke ? (
                  <div className="space-y-2 rounded border border-rose-400/30 bg-rose-400/10 p-3 text-xs text-rose-100">
                    <p>Revoke lock-screen access? This removes the permission and any saved PIN. If the device is offline, the Agent cleans up its local copy after it reconnects. Backups follow normal retention; this is not physical erasure.</p>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="destructive" data-testid="button-confirm-revoke-unlock" disabled={!!busy}
                        onClick={() => void run("revoke", () => revokeWindowsUnlock(deviceId), "Lock-screen access revoked.")}>
                        {busy === "revoke" ? "Revoking..." : "Revoke access"}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <Button type="button" size="sm" variant="destructive" data-testid="button-revoke-unlock" disabled={!!busy} onClick={() => { setConfirmForget(false); setConfirmRevoke(true); }}>
                    Revoke lock-screen access
                  </Button>
                ))}
              </div>
            )}

            {actionError && <p role="alert" className="text-xs text-rose-300" data-testid="text-unlock-error">{actionError}</p>}
            {notice && <p role="status" className="rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200" data-testid="text-unlock-notice-result">{notice}</p>}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" data-testid="button-close-unlock-settings" onClick={close}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
