-- Textos asignados a historias de Instagram. La key es el story_id que devuelve
-- la Graph API. Cuando el agente recibe el id por DM, consulta acá y obtiene
-- el texto que el operador le asignó.
CREATE TABLE IF NOT EXISTS story_texts (
  story_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS story_texts_updated_at_idx ON story_texts (updated_at DESC);
