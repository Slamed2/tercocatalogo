// POST /api/cleanup — limpia huérfanos del VS, storage y DB.
//
// Query params:
//   ?dry=1                          → solo reporta, no borra
//   ?include=zombies,event_media,stories,posts,storage  → qué limpiar
//                                     (default: zombies,event_media,stories)
//   ?orphan_posts=1                 → borrar también imágenes de posts sin
//                                     texto asignado (off por default — el
//                                     cache se llena solo y no molesta)
//
// Devuelve un JSON con el resumen de filas/files borrados.
//
// Está dentro del middleware de auth — solo accesible logueado.

import express from 'express';
import { getSql } from '../services/db.js';
import { fetchActiveStories } from '../services/meta.js';

const router = express.Router();

const VS_ID = process.env.OPENAI_VECTOR_STORE_ID;
const API_KEY = process.env.OPENAI_API_KEY;
const VS_BASE = `https://api.openai.com/v1/vector_stores/${VS_ID}`;
const FILES_BASE = 'https://api.openai.com/v1/files';

async function openaiFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${API_KEY}`, ...(opts.headers || {}) },
  });
  return r;
}

// Pagina todos los IDs del VS.
async function listVsFileIds() {
  const ids = [];
  let after;
  while (true) {
    const url = new URL(`${VS_BASE}/files`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const r = await openaiFetch(url);
    if (!r.ok) throw new Error(`VS list: ${r.status}`);
    const data = await r.json();
    for (const f of data.data) ids.push(f.id);
    if (!data.has_more) break;
    after = data.last_id || data.data[data.data.length - 1]?.id;
    if (!after) break;
  }
  return ids;
}

// Pagina todos los files purpose=assistants del proyecto.
async function listStorageFiles() {
  const files = [];
  let after;
  while (true) {
    const url = new URL(FILES_BASE);
    url.searchParams.set('purpose', 'assistants');
    url.searchParams.set('limit', '100');
    url.searchParams.set('order', 'asc');
    if (after) url.searchParams.set('after', after);
    const r = await openaiFetch(url);
    if (!r.ok) throw new Error(`storage list: ${r.status}`);
    const data = await r.json();
    for (const f of data.data) files.push({ id: f.id, filename: f.filename });
    if (!data.has_more) break;
    after = data.last_id || data.data[data.data.length - 1]?.id;
    if (!after) break;
  }
  return files;
}

router.post('/', async (req, res) => {
  if (!VS_ID || !API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY o OPENAI_VECTOR_STORE_ID no configurados' });
  }

  const dry = req.query.dry === '1' || req.query.dry === 'true';
  const include = String(req.query.include || 'zombies,event_media,stories').split(',').map((s) => s.trim());
  const orphanPosts = req.query.orphan_posts === '1';

  const report = {
    dry,
    include,
    orphan_posts: orphanPosts,
    actions: {},
  };

  try {
    const sql = getSql();

    // === Zombies del VS (file_id sin filename) ===
    if (include.includes('zombies')) {
      const vsIds = await listVsFileIds();
      const storageMap = new Map((await listStorageFiles()).map((f) => [f.id, f.filename]));
      const zombies = vsIds.filter((id) => !storageMap.has(id));
      report.actions.zombies = { found: zombies.length, deleted: 0 };
      if (!dry) {
        for (const id of zombies) {
          const r = await openaiFetch(`${VS_BASE}/files/${id}`, { method: 'DELETE' });
          if (r.ok) report.actions.zombies.deleted++;
        }
      }
    }

    // === Storage files que no están en el VS (huérfanos sueltos) ===
    if (include.includes('storage')) {
      const vsIds = new Set(await listVsFileIds());
      const storage = await listStorageFiles();
      const orphans = storage.filter((f) => !vsIds.has(f.id));
      report.actions.storage_orphans = {
        found: orphans.length,
        deleted: 0,
        files: orphans.map((f) => f.filename),
      };
      if (!dry) {
        for (const f of orphans) {
          const r = await openaiFetch(`${FILES_BASE}/${f.id}`, { method: 'DELETE' });
          if (r.ok) report.actions.storage_orphans.deleted++;
        }
      }
    }

    // === event_media con slug que no existe en events ===
    if (include.includes('event_media')) {
      const orphans = await sql`
        SELECT slug, filename FROM event_media
        WHERE slug NOT IN (SELECT slug FROM events)
      `;
      report.actions.event_media = {
        found: orphans.length,
        deleted: 0,
        sample: orphans.slice(0, 10).map((r) => `${r.slug}/${r.filename}`),
      };
      if (!dry && orphans.length) {
        const r = await sql`DELETE FROM event_media WHERE slug NOT IN (SELECT slug FROM events)`;
        report.actions.event_media.deleted = r.count;
      }
    }

    // === story_texts y story_media de stories que ya no están activas ===
    if (include.includes('stories')) {
      let activeIds = [];
      try {
        const active = await fetchActiveStories();
        activeIds = active.map((s) => s.id);
      } catch (err) {
        report.actions.stories = { error: 'no se pudo conectar a Meta: ' + err.message };
      }
      if (activeIds.length || !report.actions.stories) {
        const beforeT = (await sql`SELECT COUNT(*)::int AS c FROM story_texts`)[0].c;
        const beforeM = (await sql`SELECT COUNT(*)::int AS c FROM story_media`)[0].c;
        let deletedT = 0, deletedM = 0;
        if (!dry) {
          if (activeIds.length) {
            const rt = await sql`DELETE FROM story_texts WHERE story_id NOT IN ${sql(activeIds)}`;
            const rm = await sql`DELETE FROM story_media WHERE story_id NOT IN ${sql(activeIds)}`;
            deletedT = rt.count;
            deletedM = rm.count;
          } else {
            // Sin activas → no borramos todo por precaución.
          }
        }
        report.actions.stories = {
          active_in_ig: activeIds.length,
          story_texts_before: beforeT,
          story_media_before: beforeM,
          story_texts_deleted: deletedT,
          story_media_deleted: deletedM,
        };
      }
    }

    // === post_media sin texto asignado (opcional, off por default) ===
    if (include.includes('posts') && orphanPosts) {
      const beforeM = (await sql`SELECT COUNT(*)::int AS c FROM post_media`)[0].c;
      let deletedM = 0;
      if (!dry) {
        const rm = await sql`
          DELETE FROM post_media
          WHERE media_id NOT IN (SELECT media_id FROM post_texts)
        `;
        deletedM = rm.count;
      }
      report.actions.post_media_no_text = {
        post_media_before: beforeM,
        deleted: deletedM,
      };
    }

    // === Estado final ===
    const totals = (await sql`SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM event_media) AS event_media,
      (SELECT COUNT(*) FROM story_texts) AS story_texts,
      (SELECT COUNT(*) FROM story_media) AS story_media,
      (SELECT COUNT(*) FROM post_texts) AS post_texts,
      (SELECT COUNT(*) FROM post_media) AS post_media
    `)[0];
    report.final_state = totals;

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message, report });
  }
});

export default router;
