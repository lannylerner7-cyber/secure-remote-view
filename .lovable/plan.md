## Fix admin "column is_session_active does not exist" error

The C# admin console queries `devices?select=...,is_session_active`, but that column was never added to `public.devices`. Result: every device list refresh 400s and the UI shows the red banner.

### Fix (single migration)

Add the column and keep it accurate automatically via a trigger on `sessions`, so nothing in code needs to maintain it:

```sql
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS is_session_active boolean NOT NULL DEFAULT false;

-- Backfill from current sessions
UPDATE public.devices d
   SET is_session_active = EXISTS (
     SELECT 1 FROM public.sessions s
      WHERE s.device_id = d.id
        AND s.state IN ('invited','active')
   );

-- Trigger: recompute the flag whenever a session row changes
CREATE OR REPLACE FUNCTION public.sync_device_session_active()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.device_id, OLD.device_id);
  IF target IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  UPDATE public.devices
     SET is_session_active = EXISTS (
       SELECT 1 FROM public.sessions
        WHERE device_id = target
          AND state IN ('invited','active')
     )
   WHERE id = target;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sessions_sync_device_active ON public.sessions;
CREATE TRIGGER trg_sessions_sync_device_active
AFTER INSERT OR UPDATE OF state, device_id OR DELETE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.sync_device_session_active();
```

No code changes needed — admin console and web console will both start seeing the flag immediately.

### Agent 401 / deployment key

This is environment config, not a bug. On the test machine, do one of:

- Drop the key at `C:\ProgramData\ConnectLive\deployment.key`, or
- `set AGENT_DEPLOYMENT_KEY=<key>` before launching `ConnectLiveAgent.exe`

The agent's self-heal path (delete `device.dat` → re-enroll) then succeeds. Resolution order is already: HKLM policy → ProgramData file → env var → embedded constant (see `agent/src/DeploymentKey.cs`).

No repack of the zips is required for this turn — only the DB migration.
