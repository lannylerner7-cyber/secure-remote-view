// Development-only browser fixture. Not an application route or production
// import. Uses the real UI and crypto/controller code, but no accounts, device
// credentials, Windows hardware or shared database mutations.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WindowsUnlockSettings } from "../src/components/console/WindowsUnlockSettings";
import { WindowsUnlockControls } from "../src/components/console/WindowsUnlockControls";
import { createBrowserUnlock } from "../src/lib/browser-unlock";
import { supabase } from "../src/integrations/supabase/client";
import { pinAssociatedData, type UnlockDevice } from "../src/shared/windows-unlock";
import type { WebRtcLive } from "../src/lib/webrtc-live";

export async function mount() {
  if (!import.meta.env.DEV) throw new Error("Development-only fixture.");
  const keys = await crypto.subtle.generateKey({
    name: "RSA-OAEP", hash: "SHA-256", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["encrypt", "decrypt"]);
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))));
  const devices: UnlockDevice[] = [0, 1].map(() => ({
    deviceId: crypto.randomUUID(), enabled: true, authorizationId: crypto.randomUUID(),
    keyId: crypto.randomUUID(), publicKey, windowsAccount: "FIXTURE\\Operator",
    locked: true, helperReady: true, hasPin: false, credentialVersion: null, lastSeenAt: new Date().toISOString(),
  }));
  const requests: { method: string; deviceId: string; body: unknown }[] = [];
  const messages: any[] = [];
  const session = crypto.randomUUID(), peer = crypto.randomUUID();
  let expectedPinMatched = false, lastEnvelope: any = null, delayNext = 0;
  const originalFetch = window.fetch, originalSession = supabase.auth.getSession;
  supabase.auth.getSession = async () => ({ data: { session: { access_token: "synthetic-fixture-only" } }, error: null }) as any;
  window.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const id = url.match(/\/api\/public\/admin\/device\/([^/]+)\/unlock/)?.[1];
    // Never let a fixture credential or state change reach a real endpoint.
    if (!id) return new Response('{"error":"fixture_network_blocked"}', { status: 503 });
    const device = devices.find(row => row.deviceId === id);
    if (!device) return new Response('{"error":"unlock_forbidden"}', { status: 403 });
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    requests.push({ method, deviceId: id, body });
    if (delayNext) { const ms = delayNext; delayNext = 0; await new Promise(resolve => setTimeout(resolve, ms)); }
    if (method === "PUT") {
      lastEnvelope = body.sealedPin;
      const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
      const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keys.privateKey, bytes(lastEnvelope.wrappedKey));
      try {
        const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(lastEnvelope.iv), tagLength: 128,
          additionalData: new TextEncoder().encode(pinAssociatedData(device.deviceId, device.authorizationId!, device.keyId!)),
        }, aes, bytes(lastEnvelope.ciphertext));
        expectedPinMatched = new TextDecoder().decode(decrypted) === "00001234";
        new Uint8Array(decrypted).fill(0);
      } finally { new Uint8Array(raw).fill(0); }
      device.hasPin = true; device.credentialVersion = crypto.randomUUID();
    }
    if (method === "DELETE") {
      device.hasPin = false;
      if (body.action === "revoke") device.enabled = false;
    }
    if (method === "POST")
      return Response.json({ requestId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString() });
    return Response.json({ ...device });
  };
  let controller: ReturnType<typeof createBrowserUnlock>;
  controller = createBrowserUnlock(session, devices[0].authorizationId, message => {
    const value = message as any; messages.push(value);
    if (value.kind === "unlock_begin" || value.kind === "unlock_renew")
      setTimeout(() => receipt("ready", value.payload.request_id), 20);
    if (value.kind === "unlock_pin") setTimeout(() => receipt("submitted", value.payload.request_id), 20);
    return true;
  });
  function receipt(phase: string, requestId = controller.state().requestId) {
    controller.receive({ kind: "unlock_status", session_id: session, authorization_id: devices[0].authorizationId,
      request_id: requestId, phase });
  }
  const live = {
    sessionId: session, peerId: () => peer, state: () => "connected",
    onState: () => () => {}, unlockState: controller.state, onUnlock: controller.onState,
    beginUnlock: controller.begin, cancelUnlock: controller.cancel,
    prepareUnlock: () => messages.push({ kind: "fixture-sensitive-input-blocked" }),
    useSavedUnlockPin: controller.useSavedPin, sendUnlockInput: controller.input, sendUnlockSas: controller.sas,
  } as unknown as WebRtcLive;
  function Fixture() {
    const [index, choose] = useState(0), [open, show] = useState(false);
    return <div className="min-h-screen bg-[#0B1220] p-4 text-white">
      <h1 className="mb-4 text-lg">Isolated Windows unlock UI check</h1>
      <div className="mb-4 flex gap-4">
        <button data-testid="fixture-settings" onClick={() => show(true)}>PIN settings</button>
        <button data-testid="fixture-switch-device" onClick={() => choose(value => 1 - value)}>Switch fixture device</button>
        <span data-testid="fixture-selected-device">Device {index === 0 ? "A" : "B"}</span>
      </div>
      <WindowsUnlockControls deviceId={devices[0].deviceId} sessionId={session} live={live} canUnlock
        beforeStart={async () => { messages.push({ kind: "fixture-recording-stopped" }); }} />
      {open && <WindowsUnlockSettings key={devices[index].deviceId} deviceId={devices[index].deviceId}
        deviceName={`Fixture device ${index === 0 ? "A" : "B"}`} canManage onClose={() => show(false)} />}
    </div>;
  }
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container); root.render(<Fixture />);
  const fixture = {
    devices, requests, messages, receipt,
    result: () => ({ expectedPinMatched, envelopeKeys: lastEnvelope ? Object.keys(lastEnvelope) : [], requests, messages }),
    delay: (ms: number) => { delayNext = ms; },
    cleanup: () => {
      controller.dispose(); root.unmount(); window.fetch = originalFetch; supabase.auth.getSession = originalSession;
    },
  };
  (window as any).__unlockFixture = fixture;
}
