-- Cache de medios de stories. Las URLs de Instagram CDN expiran rápido y son
-- lentas. Cuando vemos una story por primera vez bajamos el blob y lo servimos
-- desde nuestro server con cache headers largos.
--
-- BYTEA: simple para volúmenes chicos (una story es ~50-500 KB, máximo decenas
-- de stories activas simultáneas). Si crece, migrar a S3/R2.

CREATE TABLE IF NOT EXISTS story_media (
  story_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,        -- IMAGE | VIDEO
  content_type TEXT NOT NULL,      -- image/jpeg, video/mp4, etc.
  data BYTEA NOT NULL,             -- bytes del archivo
  source_url TEXT,                 -- URL original de IG (referencia)
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS story_media_fetched_at_idx ON story_media (fetched_at DESC);
