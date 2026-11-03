import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getLiveAuthorization } from "./session-capabilities.functions";
import type { Authorization } from "./authorization.server";

export function useLiveAuthorization(sessionId: string | null, bindingId: string | null) {
  const getGrant = useServerFn(getLiveAuthorization);
  const key = sessionId && bindingId ? `${sessionId}:${bindingId}` : null;
  const [snapshot, setSnapshot] = useState<{ key: string; grant: Authorization | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !key) { setSnapshot(null); return; }
    void getGrant({ data: { sessionId } }).then(
      grant => { if (!cancelled) setSnapshot({ key, grant, error: null }); },
      () => { if (!cancelled) setSnapshot({ key, grant: null, error: "Could not verify session permissions." }); },
    );
    return () => { cancelled = true; };
  }, [key, sessionId, getGrant]);
  return snapshot?.key === key ? snapshot : { grant: null, error: null };
}
