CREATE TABLE public.portal_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_bot_token text,
  telegram_chat_id text,
  notify_on_session_start boolean NOT NULL DEFAULT true,
  notify_on_device_offline boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_settings TO authenticated;
GRANT ALL ON public.portal_settings TO service_role;
ALTER TABLE public.portal_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portal_settings_own" ON public.portal_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.support_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  license_id uuid REFERENCES public.licenses(id) ON DELETE SET NULL,
  contact_email text NOT NULL,
  topic text NOT NULL,
  preferred_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  notes text,
  status text NOT NULL DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.support_bookings TO authenticated;
GRANT ALL ON public.support_bookings TO service_role;
ALTER TABLE public.support_bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support_bookings_select_own" ON public.support_bookings FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "support_bookings_insert_own" ON public.support_bookings FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);