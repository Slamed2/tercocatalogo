-- Schema inicial: catálogo de eventos + settings master.
-- Idempotente — se puede correr múltiples veces sin romper datos existentes.

CREATE TABLE IF NOT EXISTS events (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  is_rules BOOLEAN NOT NULL DEFAULT false,
  is_index BOOLEAN NOT NULL DEFAULT false,
  openai_file_id TEXT,
  display_order INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_display_order_idx ON events (display_order, slug);
CREATE INDEX IF NOT EXISTS events_updated_at_idx ON events (updated_at DESC);

-- Settings global del repositorio (preamble del catálogo, file_ids derivados, etc.)
-- Single-row: siempre id=1.
CREATE TABLE IF NOT EXISTS master_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  preamble TEXT NOT NULL DEFAULT '',
  catalog_file_id TEXT,
  lista_file_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

-- Inicializar la fila si no existe.
INSERT INTO master_settings (id, preamble) VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
