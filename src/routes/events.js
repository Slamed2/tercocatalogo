import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMultiEventMd } from '../services/mdsplit.js';
import { listVectorStoreFiles } from '../services/openai.js';
import {
  ensureDirs,
  readMasterMeta,
  writeMasterMeta,
  readEventMeta,
  writeEventMeta,
  writeEventContent,
  readEventContent,
  makeSlug,
  syncEventFile,
  syncMasterFile,
  syncAllToVectorStore,
  deleteEventCompletely,
  pullFromVectorStore,
  buildFullMd,
  buildListaEventosMd,
  writeListaEventos,
  syncListaEventosFile,
  loadAllEventsInOrder,
  DATA_DIR,
  RULES_SLUG,
  INDEX_SLUG,
  RESERVED_SLUGS,
} from '../services/master.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await ensureDirs();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = express.Router();

async function findImage(slug) {
  const dir = path.join(DATA_DIR, slug);
  try {
    const files = await fs.readdir(dir);
    return files.find((f) => /^image\.(jpg|jpeg|png|webp|gif)$/i.test(f));
  } catch {
    return null;
  }
}

// Procesa línea por línea para evitar que `\S+` cruce saltos y agarre el `-`
// del bullet de la próxima línea cuando una entrada MAPA_DE no tiene URL
// (ej. evento con varios mapas y uno vacío).
const MAP_LINE_RE = /^\s*-?\s*MAPA_DE\s+"[^"]*"\s*→\s*(\S+)/;

function extractFirstMapUrl(content) {
  if (!content) return null;
  for (const line of content.split('\n')) {
    const m = MAP_LINE_RE.exec(line);
    if (m && m[1] && m[1] !== '-') return m[1];
  }
  return null;
}

// Si la URL es relativa (`/mapas/...`) y hay PUBLIC_BASE_URL, devolver la
// versión absoluta. Sirve cuando se desarrolla local pero las imágenes están
// en el server público.
function absolutize(url) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return url;
  return base + url;
}

async function findFirstMapUrl(slug) {
  try {
    const content = await readEventContent(slug);
    return extractFirstMapUrl(content);
  } catch {
    return null;
  }
}

// GET /api/events — listar (incluye reglas al final)
router.get('/', async (_req, res) => {
  try {
    const { master, events: rows } = await loadAllEventsInOrder();
    const events = [];
    for (const e of rows) {
      if (e.meta.is_index) continue; // legacy: no mostrar en grid
      const imageName = await findImage(e.slug);
      const image = imageName ? `/data/eventos/${e.slug}/${imageName}` : null;
      const mapUrl = image ? null : extractFirstMapUrl(e.content);
      events.push({
        slug: e.slug,
        title: e.title,
        updated_at: e.meta.updated_at || null,
        is_rules: !!e.meta.is_rules,
        openai_file_id: master.openai_file_id || null,
        image: absolutize(image || mapUrl),
      });
    }
    const indexInfo = master.openai_file_id
      ? { filename: 'terco-tour-catalogo.md', openai_file_id: master.openai_file_id, updated_at: master.updated_at }
      : null;
    res.json({ events, total: events.length, index: indexInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/preview — .md ensamblado
router.get('/preview', async (_req, res) => {
  try {
    const md = await buildFullMd();
    res.type('text/markdown').send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/all — todos los eventos con su contenido completo (JSON).
// Usado por la página /preview para mostrar cada evento por separado con buscador.
// Incluye reglas y agente-reservas (con flag is_special) para visibilidad.
router.get('/all', async (_req, res) => {
  try {
    const { events: rows } = await loadAllEventsInOrder();
    const events = [];
    for (const e of rows) {
      if (e.meta.is_index) continue;
      const imageName = await findImage(e.slug);
      events.push({
        slug: e.slug,
        title: e.title,
        content: e.content,
        is_rules: !!e.meta.is_rules,
        is_special: ['agente-reservas'].includes(e.slug),
        image: imageName ? `/data/eventos/${e.slug}/${imageName}` : null,
        updated_at: e.meta.updated_at || null,
      });
    }
    res.json({ events, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/lista — lista compacta de eventos (solo títulos), siempre fresca.
// Pensada para pegar en el system prompt del agente. Soporta ?download=1 para
// forzar descarga del archivo en el browser.
router.get('/lista', async (req, res) => {
  try {
    const md = await buildListaEventosMd();
    // También persistimos a disco — así el archivo en data/_master/ queda siempre al día.
    await writeListaEventos().catch(() => {});
    if (req.query.download) {
      res.setHeader('Content-Disposition', 'attachment; filename="lista-eventos.md"');
    }
    res.type('text/markdown').send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/sync — re-sync completo con progreso NDJSON.
router.post('/sync', async (_req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };
  try {
    await syncAllToVectorStore(send);
  } catch (err) {
    console.error('sync failed:', err);
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

// POST /api/events/openai/pull — descarga todo el VS y reconstruye estado local.
// Responde NDJSON streaming con el progreso.
router.post('/openai/pull', async (_req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };
  try {
    await pullFromVectorStore(send);
  } catch (err) {
    console.error('pull failed:', err);
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

// GET /api/events/openai/files
router.get('/openai/files', async (_req, res) => {
  try {
    const files = await listVectorStoreFiles();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/openai/import-local — subir archivo multi-evento, parsearlo y subir todos por separado
router.post('/openai/import-local', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'archivo requerido' });
    const content = req.file.buffer.toString('utf8');

    const { preamble, events, footer } = parseMultiEventMd(content);
    if (!events.length) {
      return res.status(400).json({
        error: 'No se detectaron eventos bajo "## Eventos".',
      });
    }

    // Borrar eventos previos localmente.
    const master = await readMasterMeta();
    for (const old of master.order || []) {
      await deleteEventCompletely(old).catch(() => {});
    }
    await deleteEventCompletely(RULES_SLUG).catch(() => {});
    await deleteEventCompletely(INDEX_SLUG).catch(() => {});

    const order = [];
    const now = new Date().toISOString();
    const usedSlugs = new Set();

    for (const ev of events) {
      let slug = makeSlug(ev.title) || `evento-${order.length + 1}`;
      const base = slug;
      let i = 2;
      // Verificar contra slugs usados en este loop + los que ya están en DB.
      while (usedSlugs.has(slug) || (await readEventMeta(slug))) {
        slug = `${base}-${i++}`;
      }
      usedSlugs.add(slug);
      await writeEventMeta(slug, {
        title: ev.title,
        created_at: now,
        updated_at: now,
        is_rules: false,
      });
      await writeEventContent(slug, ev.content);
      // Imágenes siguen yendo al filesystem (public/mapas/<slug>/).
      const firstUrl = ev.imageUrls?.[0];
      if (firstUrl) {
        try {
          const resp = await fetch(firstUrl);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const ext = (firstUrl.match(/\.(jpg|jpeg|png|webp|gif)(?:\?|$)/i) || [])[1] || 'jpg';
            const imgDir = path.join(DATA_DIR, slug);
            await fs.mkdir(imgDir, { recursive: true });
            await fs.writeFile(path.join(imgDir, `image.${ext.toLowerCase()}`), buf);
          }
        } catch {}
      }
      order.push(slug);
    }

    let rulesContent = (footer || '').trim();
    if (rulesContent.startsWith('##')) {
      rulesContent = rulesContent.replace(/^##\s+Reglas comunes[^\n]*\n*/i, '').trim();
    }
    if (rulesContent) {
      await writeEventContent(RULES_SLUG, rulesContent);
      await writeEventMeta(RULES_SLUG, {
        title: 'Reglas comunes',
        created_at: now,
        updated_at: now,
        is_rules: true,
      });
      order.push(RULES_SLUG);
    }

    await writeMasterMeta({
      preamble: preamble || '',
      order,
      updated_at: now,
    });

    // Un solo upload al VS con el archivo unificado + regenerar lista.
    let masterFileId = null;
    try {
      masterFileId = await syncMasterFile();
    } catch (err) {
      console.error('syncMasterFile:', err.message);
    }
    try { await syncListaEventosFile(); } catch (err) { console.error('sync lista-eventos:', err.message); }

    res.json({
      ok: true,
      imported_events: events.length,
      rules: !!rulesContent,
      total_files: masterFileId ? 1 : 0,
      openai_file_id: masterFileId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/:slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const meta = await readEventMeta(slug);
    if (!meta) return res.status(404).json({ error: 'No existe' });
    const content = await readEventContent(slug);
    const imageName = await findImage(slug);
    const master = await readMasterMeta();
    res.json({
      slug,
      title: meta.title,
      content,
      updated_at: meta.updated_at,
      openai_file_id: master.openai_file_id || null,
      is_rules: !!meta.is_rules,
      image: imageName ? `/data/eventos/${slug}/${imageName}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events — crear nuevo evento
router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const slug = makeSlug(title);
    if (!slug) return res.status(400).json({ error: 'title inválido' });
    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ error: `nombre reservado por el sistema: "${slug}"` });
    }
    // Chequear si ya existe en DB.
    const existing = await readEventMeta(slug);
    if (existing) return res.status(409).json({ error: 'ya existe' });
    const now = new Date().toISOString();
    await writeEventMeta(slug, {
      title,
      created_at: now,
      updated_at: now,
      is_rules: false,
    });
    await writeEventContent(slug, '');

    const master = await readMasterMeta();
    const order = master.order || [];
    const rulesIdx = order.indexOf(RULES_SLUG);
    if (rulesIdx >= 0) order.splice(rulesIdx, 0, slug);
    else order.push(slug);
    await writeMasterMeta({ ...master, order });

    // Auto-sync: subir el archivo vacío + actualizar el catálogo + sync lista al VS.
    const [eventRes, catalogRes, listaRes] = await Promise.allSettled([
      syncEventFile(slug),
      syncMasterFile(),
      syncListaEventosFile(),
    ]);
    if (eventRes.status === 'rejected') console.error('auto-sync evento nuevo falló:', eventRes.reason?.message);
    if (catalogRes.status === 'rejected') console.error('auto-sync catálogo falló:', catalogRes.reason?.message);
    if (listaRes.status === 'rejected') console.error('sync lista-eventos falló:', listaRes.reason?.message);

    res.json({ slug, title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/events/:slug — guardar + sync ese archivo
router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { title, content } = req.body;
    const meta = await readEventMeta(slug);
    if (!meta) return res.status(404).json({ error: 'No existe' });

    await writeEventContent(slug, content ?? '');
    await writeEventMeta(slug, {
      ...meta,
      title: title || meta.title,
      updated_at: new Date().toISOString(),
    });

    // Auto-sync: subir el archivo del evento + actualizar el catálogo + regenerar lista.
    // Si alguno falla, respondemos 200 igual pero lo logueamos y avisamos al cliente.
    const [eventRes, catalogRes, listaRes] = await Promise.allSettled([
      syncEventFile(slug),
      syncMasterFile(),
      syncListaEventosFile(),
    ]);
    if (eventRes.status === 'rejected') console.error('auto-sync evento falló:', eventRes.reason?.message);
    if (catalogRes.status === 'rejected') console.error('auto-sync catálogo falló:', catalogRes.reason?.message);
    if (listaRes.status === 'rejected') console.error('sync lista-eventos falló:', listaRes.reason?.message);
    res.json({
      ok: true,
      openai_file_id: eventRes.status === 'fulfilled' ? eventRes.value : null,
      synced: eventRes.status === 'fulfilled' && catalogRes.status === 'fulfilled',
      sync_error: [
        eventRes.status === 'rejected' ? `evento: ${eventRes.reason?.message}` : null,
        catalogRes.status === 'rejected' ? `catálogo: ${catalogRes.reason?.message}` : null,
      ].filter(Boolean).join(' | ') || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:slug/map — sube una imagen a public/mapas/<slug>/ y devuelve URL absoluta.
// Si PUBLIC_BASE_URL está seteada, devuelve URL completa; sino, relativa /mapas/<slug>/...
router.post('/:slug/map', upload.single('map'), async (req, res) => {
  try {
    const { slug } = req.params;
    if (!req.file) return res.status(400).json({ error: 'map requerida' });
    const meta = await readEventMeta(slug);
    if (!meta) return res.status(404).json({ error: 'No existe' });
    const ext = (req.file.originalname.match(/\.(jpg|jpeg|png|webp|gif)$/i) || ['.jpg'])[0].toLowerCase();
    // Una subcarpeta por evento: /mapas/<slug>/imagenN.ext
    const eventDir = path.join(path.dirname(DATA_DIR), '..', 'public', 'mapas', slug);
    await fs.mkdir(eventDir, { recursive: true });
    // Próximo índice: cuento los imagenN.* existentes.
    let n = 1;
    try {
      const files = await fs.readdir(eventDir);
      const used = files
        .map((f) => (f.match(/^imagen(\d+)\./i) || [])[1])
        .filter(Boolean)
        .map((s) => parseInt(s, 10));
      if (used.length) n = Math.max(...used) + 1;
    } catch {}
    const filename = `imagen${n}${ext}`;
    await fs.writeFile(path.join(eventDir, filename), req.file.buffer);
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    res.json({ url: `${base}/mapas/${slug}/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:slug/image
router.post('/:slug/image', upload.single('image'), async (req, res) => {
  try {
    const { slug } = req.params;
    if (!req.file) return res.status(400).json({ error: 'image requerida' });
    const meta = await readEventMeta(slug);
    if (!meta) return res.status(404).json({ error: 'No existe' });
    const ext = (req.file.originalname.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [])[0] || '.jpg';
    const dir = path.join(DATA_DIR, slug);
    const existing = await findImage(slug);
    if (existing) await fs.unlink(path.join(dir, existing)).catch(() => {});
    const filename = `image${ext.toLowerCase()}`;
    await fs.writeFile(path.join(dir, filename), req.file.buffer);
    res.json({ image: `/data/eventos/${slug}/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/:slug
router.delete('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    await deleteEventCompletely(slug);
    try { await syncMasterFile(); } catch (err) { console.error('syncMasterFile:', err.message); }
    try { await syncListaEventosFile(); } catch (err) { console.error('sync lista-eventos:', err.message); }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
