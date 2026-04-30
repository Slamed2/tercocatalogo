-- Almacenamiento persistente de imágenes de mapas (mapas/sectores) por evento.
-- Hasta ahora vivían en public/mapas/<slug>/imagenN.ext del filesystem, que en
-- easypanel se borra con cada redeploy. Mover a Postgres BYTEA garantiza
-- persistencia entre deploys.

CREATE TABLE IF NOT EXISTS event_media (
  slug TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, filename)
);

CREATE INDEX IF NOT EXISTS event_media_slug_idx ON event_media (slug);
