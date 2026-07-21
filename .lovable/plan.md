## Restore Telegram settings visibility

### Diagnosis
The Telegram settings panel was not removed — it's still in `admin.tsx` (lines 352–360, `TelegramSettings`). It's hidden because the sidebar gates the Settings tab behind `role === "super_admin"`, and the `197200` account is currently stored as `role = 'technician'` in `public.user_roles` (verified via DB query). `technician` isn't part of the `super_admin | admin | viewer` model the UI uses, so the whole sidebar renders in its lowest-privilege state.

### Fix (one migration, no code changes)
Promote `197200` to `super_admin` and remove the stale `technician` row:

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('9209c21d-55a1-4152-a4bf-e6921c7473c4', 'super_admin')
ON CONFLICT (user_id, role) DO NOTHING;

DELETE FROM public.user_roles
WHERE user_id = '9209c21d-55a1-4152-a4bf-e6921c7473c4'
  AND role = 'technician';
```

After the migration runs, sign out and back in — the Settings tab reappears with the Telegram bot token / chat ID / per-event toggles, and Team management also becomes visible.

### Not doing
- No UI changes; the Telegram panel code is intact.
- Not lowering the gate to `admin` — Telegram credentials are workspace-wide secrets and should stay super_admin only.