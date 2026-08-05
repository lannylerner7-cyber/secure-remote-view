CREATE TABLE public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL DEFAULT 'subscribed',
  source text NOT NULL DEFAULT 'homepage',
  ip_hash text,
  welcome_sent_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscribers_status_chk CHECK (status IN ('subscribed','unsubscribed')),
  CONSTRAINT newsletter_subscribers_email_key UNIQUE (email)
);

GRANT ALL ON public.newsletter_subscribers TO service_role;
GRANT SELECT ON public.newsletter_subscribers TO authenticated;

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admins can read subscribers"
ON public.newsletter_subscribers FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'super_admin'));

CREATE INDEX newsletter_subscribers_created_idx ON public.newsletter_subscribers (created_at DESC);