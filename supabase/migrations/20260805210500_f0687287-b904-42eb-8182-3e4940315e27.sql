CREATE TABLE public.contact_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'contact',
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notified_at TIMESTAMPTZ,
  ack_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.contact_messages TO service_role;

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages contact messages"
  ON public.contact_messages FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX contact_messages_created_idx ON public.contact_messages (created_at DESC);
CREATE INDEX contact_messages_ip_idx ON public.contact_messages (ip_hash, created_at DESC);

CREATE TRIGGER update_contact_messages_updated_at
  BEFORE UPDATE ON public.contact_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();