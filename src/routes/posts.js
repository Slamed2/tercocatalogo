// Endpoints de gestión de textos para publicaciones (posts/reels) de Instagram.
//
//   GET    /api/posts                  → lista posts recientes + texto asignado
//   GET    /api/posts/:id/text         → solo {text} (público, lo consume el agente)
//   PUT    /api/posts/:id/text         → asigna/actualiza texto (admin con cookie,
//                                         o externo con header X-API-Key)
//   DELETE /api/posts/:id/text         → borra texto (admin)
//   GET    /api/posts/:id/media        → imagen cacheada del post (público)
//
// Los handlers públicos se montan aparte en server.js antes del auth para que
// el agente y los <img> puedan acceder sin cookie.

import express from 'express';
import { getSql } from '../services/db.js';
import { fetchRecentPosts } from '../services/meta.js';

const router = express.Router();

// Descarga el media de IG y lo guarda en post_media. Idempotente (ON CONFLICT
// DO NOTHING). Llamada en background — no bloquea la respuesta.
async function cachePostMediaInBackground(post) {
  const sql = getSql();
  // Para videos y reels, usamos la thumbnail. Para imágenes y carousels, el media_url.
  const url = (post.media_type === 'VIDEO' || post.media_type === 'REELS')
    ? (post.thumbnail_url || post.media_url)
    : post.media_url;
  if (!url) return;
  try {
    const [existing] = await sql`SELECT 1 FROM post_media WHERE media_id = ${post.id}`;
    if (existing) return;

    const r = await fetch(url);
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'image/jpeg';

    await sql`
      INSERT INTO post_media (media_id, media_type, content_type, data, source_url, fetched_at)
      VALUES (${post.id}, ${post.media_type || 'IMAGE'}, ${contentType}, ${buf}, ${url}, now())
      ON CONFLICT (media_id) DO NOTHING
    `;
  } catch (err) {
    console.warn(`[posts] cache falló para ${post.id}:`, err.message);
  }
}

// GET /api/posts — lista publicaciones recientes + texto asignado (si existe)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10), 1), 100);
    const posts = await fetchRecentPosts(limit);
    if (!posts.length) {
      return res.json({ posts: [], total: 0 });
    }

    const sql = getSql();
    const ids = posts.map((p) => p.id);
    const texts = await sql`SELECT media_id, text, updated_at FROM post_texts WHERE media_id IN ${sql(ids)}`;
    const textMap = new Map(texts.map((r) => [r.media_id, r]));

    // Cache de media en background para acelerar futuras cargas.
    for (const p of posts) {
      cachePostMediaInBackground(p).catch(() => {});
    }

    const enriched = posts.map((p) => {
      const t = textMap.get(p.id);
      return {
        id: p.id,
        caption: p.caption || '',
        media_url: p.media_url || null,
        media_type: p.media_type || null,
        thumbnail_url: p.thumbnail_url || null,
        cached_url: `/api/posts/${encodeURIComponent(p.id)}/media`,
        permalink: p.permalink || null,
        timestamp: p.timestamp || null,
        like_count: p.like_count ?? null,
        comments_count: p.comments_count ?? null,
        text: t?.text || '',
        text_updated_at: t?.updated_at || null,
      };
    });

    res.json({ posts: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/posts/:id/text (admin con cookie)
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
      INSERT INTO post_texts (media_id, text, updated_at)
      VALUES (${id}, ${trimmed}, now())
      ON CONFLICT (media_id) DO UPDATE SET
        text = EXCLUDED.text,
        updated_at = now()
    `;
    res.json({ ok: true, media_id: id, text: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/posts/:id/text (admin con cookie)
router.delete('/:id/text', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = getSql();
    await sql`DELETE FROM post_texts WHERE media_id = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// === Handlers públicos (se montan antes del auth en server.js) ===

// GET /api/posts/:id/text — lo consume el agente.
export async function publicGetPostText(req, res) {
  try {
    const { id } = req.params;
    const sql = getSql();
    const [row] = await sql`SELECT text, updated_at FROM post_texts WHERE media_id = ${id}`;
    if (!row) {
      return res.status(404).json({ error: 'no hay texto asignado para esta publicación', media_id: id });
    }
    res.json({ media_id: id, text: row.text, updated_at: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// PUT /api/posts/:id/text — escritura externa con X-API-Key. Sin header llama
// next() para que caiga al middleware de auth y siga al router admin.
export async function publicPutPostText(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next();

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
      INSERT INTO post_texts (media_id, text, updated_at)
      VALUES (${id}, ${trimmed}, now())
      ON CONFLICT (media_id) DO UPDATE SET
        text = EXCLUDED.text,
        updated_at = now()
    `;
    res.json({ ok: true, media_id: id, text: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/posts/:id/media — sirve la imagen cacheada del post.
export async function publicGetPostMedia(req, res) {
  try {
    const { id } = req.params;
    const sql = getSql();
    const [row] = await sql`SELECT content_type, data FROM post_media WHERE media_id = ${id}`;
    if (!row) {
      return res.status(404).send('media no cacheada todavía');
    }
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(row.data);
  } catch (err) {
    res.status(500).send(err.message);
  }
}
