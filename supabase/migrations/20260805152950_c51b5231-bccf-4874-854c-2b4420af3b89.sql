-- 'customer' role for portal accounts
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'customer';

CREATE TABLE public.licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id TEXT NOT NULL UNIQUE,
  user_id UUID,
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  company TEXT,
  plan_code TEXT REFERENCES public.plans(code),
  seat_limit INTEGER NOT NULL DEFAULT 10 CHECK (seat_limit > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX licenses_user_idx ON public.licenses (user_id);
CREATE INDEX licenses_email_idx ON public.licenses (lower(contact_email));

CREATE TRIGGER licenses_touch BEFORE UPDATE ON public.licenses
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

GRANT SELECT ON public.licenses TO authenticated;
GRANT ALL ON public.licenses TO service_role;
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff read licenses" ON public.licenses
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "customer reads own license" ON public.licenses
FOR SELECT TO authenticated
USING (user_id = auth.uid());

-- Device ↔ license binding
ALTER TABLE public.devices
  ADD COLUMN license_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL,
  ADD COLUMN license_state TEXT NOT NULL DEFAULT 'unlicensed'
    CHECK (license_state IN ('unlicensed','active','blocked','expired'));

CREATE INDEX devices_license_idx ON public.devices (license_id);

CREATE POLICY "customer reads own devices" ON public.devices
FOR SELECT TO authenticated
USING (
  license_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.licenses l
    WHERE l.id = devices.license_id AND l.user_id = auth.uid()
  )
);

CREATE POLICY "customer deletes own devices" ON public.devices
FOR DELETE TO authenticated
USING (
  license_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.licenses l
    WHERE l.id = devices.license_id AND l.user_id = auth.uid()
  )
);

-- Orders can renew / upgrade an existing license
ALTER TABLE public.orders
  ADD COLUMN license_id UUID REFERENCES public.licenses(id) ON DELETE SET NULL;

-- Human-readable meeting id: CL-XXXX-XXXX (Crockford-ish, no I/O/0/1)
CREATE OR REPLACE FUNCTION public.generate_meeting_id()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alphabet TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate TEXT;
  i INT;
BEGIN
  LOOP
    candidate := 'CL-';
    FOR i IN 1..4 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    candidate := candidate || '-';
    FOR i IN 1..4 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.licenses WHERE meeting_id = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_meeting_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_meeting_id() TO service_role;