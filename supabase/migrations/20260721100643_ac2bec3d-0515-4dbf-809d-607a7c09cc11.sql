
CREATE TABLE public.admin_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_bot_token text,
  telegram_chat_id text,
  notify_on_session_start boolean NOT NULL DEFAULT true,
  notify_on_control_taken boolean NOT NULL DEFAULT true,
  notify_on_device_offline boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_settings TO authenticated;
GRANT ALL ON public.admin_settings TO service_role;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own settings" ON public.admin_settings FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS standing_consent boolean NOT NULL DEFAULT true;
