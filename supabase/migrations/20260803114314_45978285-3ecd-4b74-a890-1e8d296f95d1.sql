CREATE TABLE public.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  channel text NOT NULL DEFAULT 'stable',
  version text NOT NULL,
  download_url text NOT NULL,
  sha256 text,
  notes text,
  min_supported_version text,
  mandatory boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT releases_product_check CHECK (product IN ('agent','admin')),
  CONSTRAINT releases_channel_check CHECK (channel IN ('stable','beta')),
  UNIQUE (product, channel, version)
);

CREATE INDEX releases_lookup_idx ON public.releases (product, channel, published, published_at DESC);

GRANT SELECT ON public.releases TO authenticated;
GRANT ALL ON public.releases TO service_role;

ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in technicians can read published releases"
ON public.releases FOR SELECT TO authenticated
USING (published = true);
