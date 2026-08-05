-- SMTP settings: singleton row, server-only (no authenticated policies; read via server functions with the service role)
CREATE TABLE public.smtp_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 587,
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT 'ConnectLive',
  from_address TEXT NOT NULL DEFAULT '',
  reply_to TEXT NOT NULL DEFAULT '',
  encryption TEXT NOT NULL DEFAULT 'starttls' CHECK (encryption IN ('none','starttls','ssl')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

GRANT ALL ON public.smtp_settings TO service_role;
ALTER TABLE public.smtp_settings ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: the SMTP password must never reach a browser client.

INSERT INTO public.smtp_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Order email log
CREATE TABLE public.order_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('order_received','order_confirmed','test')),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','skipped','error')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_emails_order_idx ON public.order_emails (order_id, created_at DESC);

GRANT SELECT ON public.order_emails TO authenticated;
GRANT ALL ON public.order_emails TO service_role;
ALTER TABLE public.order_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins read order emails" ON public.order_emails
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));