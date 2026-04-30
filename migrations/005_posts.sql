-- Textos asignados a publicaciones de Instagram (posts/reels). La key es el
-- media_id que devuelve la Graph API. Cuando alguien comenta el post, el
-- agente recibe el media_id y consulta acá el texto a responder.
CREATE TABLE IF NOT EXISTS post_texts (
  media_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_texts_updated_at_idx ON post_texts (updated_at DESC);

-- Cache local de las imágenes/thumbnails de posts. Las URLs de IG CDN son
-- lentas y pueden expirar. Bajamos el blob una vez y servimos desde nuestro
-- server con cache headers largos.
CREATE TABLE IF NOT EXISTS post_media (
  media_id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  source_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_media_fetched_at_idx ON post_media (fetched_at DESC);
