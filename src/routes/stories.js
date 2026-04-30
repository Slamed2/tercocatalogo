// Endpoints de gestión de textos para historias de Instagram.
//
//   GET    /api/stories              → lista historias activas + texto asignado
//   GET    /api/stories/:id/text     → solo {text} (público, lo consume el agente)
//   PUT    /api/stories/:id/text     → asigna/actualiza texto (admin)
//   DELETE /api/stories/:id/text     → borra texto (admin)
//
// Los endpoints de admin se montan dentro del middleware de auth en server.js.
// El endpoint público (GET /:id/text) se monta antes del auth así Chatrace
// puede consultarlo sin cookie.

import express from 'express';
import { getSql } from '../services/db.js';
import { fetchActiveStories } from '../services/meta.js';

const router = express.Router();

// Descarga el media de IG y lo guarda en story_media (BYTEA). Idempotente:
// si ya está, no vuelve a descargar. Llamada en background — no bloquea.
async function cacheStoryMediaInBackground(story) {
  const sql = getSql();
  const url = story.media_type === 'VIDEO'
    ? (story.thumbnail_url || story.media_url)
    : story.media_url;
  if (!url) return;
  try {
    // ¿Ya está cacheado?
    const [existing] = await sql`SELECT 1 FROM story_media WHERE story_id = ${story.id}`;
    if (existing) return;

    const r = await fetch(url);
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'image/jpeg';

    await sql`
      INSERT INTO story_media (story_id, media_type, content_type, data, source_url, fetched_at)
      VALUES (${story.id}, ${story.media_type || 'IMAGE'}, ${contentType}, ${buf}, ${url}, now())
      ON CONFLICT (story_id) DO NOTHING
    `;
  } catch (err) {
    console.warn(`[stories] cache falló para ${story.id}:`, err.message);
  }
}

// GET /api/stories — lista historias activas + texto asignado (si existe)
router.get('/', async (_req, res) => {
  try {
    const stories = await fetchActiveStories();
    if (!stories.length) {
      return res.json({ stories: [], total: 0 });
    }

    const sql = getSql();
    const ids = stories.map((s) => s.id);
    const texts = await sql`SELECT story_id, text, updated_at FROM story_texts WHERE story_id IN ${sql(ids)}`;
    const textMap = new Map(texts.map((r) => [r.story_id, r]));

    // Cache de media: lanzamos en background los que falten, sin bloquear.
    for (const s of stories) {
      cacheStoryMediaInBackground(s).catch(() => {});
    }

    const enriched = stories.map((s) => {
      const t = textMap.get(s.id);
      return {
        id: s.id,
        media_url: s.media_url || null,
        media_type: s.media_type || null,
        thumbnail_url: s.thumbnail_url || null,
        // URL local cacheada — el frontend la usa preferentemente.
        cached_url: `/api/stories/${encodeURIComponent(s.id)}/media`,
        permalink: s.permalink || null,
        timestamp: s.timestamp || null,
        text: t?.text || '',
        text_updated_at: t?.updated_at || null,
      };
    });

    res.json({ stories: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/stories/:id/text — asigna o actualiza el texto.
router.put('/:id/text', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text requerido (string)' });
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'text vacío — usá DELETE para borrar' });
    }

    const sql = getSql();
    await sql`
      INSERT INTO story_texts (story_id, text, updated_at)
      VALUES (${id}, ${trimmed}, now())
      ON CONFLICT (story_id) DO UPDATE SET
        text = EXCLUDED.text,
        updated_at = now()
    `;
    res.json({ ok: true, story_id: id, text: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stories/:id/text — borra el texto asignado.
router.delete('/:id/text', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = getSql();
    await sql`DELETE FROM story_texts WHERE story_id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// Sirve el media cacheado de una story directamente desde la DB. Si no está
// cacheado todavía (race con el background fetch), redirige a la URL original
// de IG como fallback. Cache headers largos: las stories no cambian.
export async function publicGetStoryMedia(req, res) {
  try {
    const { id } = req.params;
    const sql = getSql();
    const [row] = await sql`SELECT content_type, data, source_url FROM story_media WHERE story_id = ${id}`;
    if (!row) {
      // Fallback: bajar de IG ahora si tenemos source_url.
      // Como no la tenemos acá, devolvemos 404 — el cache se irá llenando.
      return res.status(404).send('media no cacheada todavía');
    }
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(row.data);
  } catch (err) {
    res.status(500).send(err.message);
  }
}

// Handler público — solo el GET del texto. Se monta aparte en server.js antes
// del auth middleware para que el agente pueda consultarlo sin cookie.
export async function publicGetStoryText(req, res) {
  try {
    const { id } = req.params;
    const sql = getSql();
    const [row] = await sql`SELECT text, updated_at FROM story_texts WHERE story_id = ${id}`;
    if (!row) {
      return res.status(404).json({ error: 'no hay texto asignado para esta historia', story_id: id });
    }
    res.json({ story_id: id, text: row.text, updated_at: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Handler público para asignar/actualizar texto. Requiere `X-API-Key` con el
// valor de STORIES_API_KEY. Sin el header, llama next() para que el flujo
// caiga al middleware de auth (UI logueada con cookie usa esa rama).
export async function publicPutStoryText(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  // Sin API key → seguir al middleware de auth (path UI con cookie).
  if (!apiKey) return next();

  // Con API key → autenticar contra STORIES_API_KEY.
  if (!process.env.STORIES_API_KEY) {
    return res.status(503).json({ error: 'STORIES_API_KEY no configurada en el servidor' });
  }
  if (apiKey !== process.env.STORIES_API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }

  try {
    const { id } = req.params;
    const { text } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text requerido (string)' });
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return res.status(400).json({ error: 'text vacío — usá DELETE para borrar' });
    }
    const sql = getSql();
    await sql`
      INSERT INTO story_texts (story_id, text, updated_at)
      VALUES (${id}, ${trimmed}, now())
      ON CONFLICT (story_id) DO UPDATE SET
        text = EXCLUDED.text,
        updated_at = now()
    `;
    res.json({ ok: true, story_id: id, text: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
