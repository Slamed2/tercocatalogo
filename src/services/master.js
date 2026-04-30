// Gestión del catálogo de eventos:
//  - Storage: Postgres (tablas events + master_settings).
//  - Vector store: un archivo por evento (`{slug}.md`) + lista-eventos.md global.
//  - Imágenes: filesystem (`public/mapas/<slug>/`).
//
// Migrado del filesystem (data/eventos/*) a DB en abril 2026 para tener
// persistencia real entre deploys de easypanel.

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import slugify from 'slugify';
import { fileURLToPath } from 'url';
import { assembleMultiEventMd, parseMultiEventMd } from './mdsplit.js';
import { getSql } from './db.js';
import {
  syncFileToVectorStore,
  cleanupOrphans,
  deleteFromVectorStore,
  listVectorStoreFiles,
  downloadFileContent,
  dedupeByFilename,
} from './openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data/eventos');     // legacy: solo lectura para migración inicial
const MASTER_DIR = path.join(__dirname, '../../data/_master');   // sigue usándose para tmp uploads y lista-eventos.md servida por endpoint
const RULES_SLUG = 'reglas-comunes';
const INDEX_SLUG = '_indice';
const MASTER_FILENAME = 'terco-tour-catalogo.md';

export async function ensureDirs() {
  // El DATA_DIR sigue existiendo para retrocompatibilidad / migraciones.
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MASTER_DIR, { recursive: true });
}

// === Master settings (single-row table) ===

export async function readMasterMeta() {
  const sql = getSql();
  const [row] = await sql`SELECT * FROM master_settings WHERE id = 1`;
  if (!row) return { preamble: '', order: [], updated_at: null, openai_file_id: null, lista_file_id: null };

  // Reconstruir el array `order` desde events.display_order.
  const orderRows = await sql`
    SELECT slug FROM events
    WHERE display_order IS NOT NULL
    ORDER BY display_order ASC, slug ASC
  `;
  const order = orderRows.map((r) => r.slug);

  return {
    preamble: row.preamble || '',
    order,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    openai_file_id: row.catalog_file_id || null,
    lista_file_id: row.lista_file_id || null,
  };
}

export async function writeMasterMeta(meta) {
  const sql = getSql();
  // Actualizar campos de master_settings.
  await sql`
    UPDATE master_settings SET
      preamble = ${meta.preamble || ''},
      catalog_file_id = ${meta.openai_file_id || null},
      lista_file_id = ${meta.lista_file_id || null},
      updated_at = now()
    WHERE id = 1
  `;
  // Si vino un array `order`, actualizar el display_order de cada slug.
  if (Array.isArray(meta.order)) {
    for (let i = 0; i < meta.order.length; i++) {
      const slug = meta.order[i];
      await sql`UPDATE events SET display_order = ${i} WHERE slug = ${slug}`;
    }
  }
}

// === Event meta + content ===

// Devuelve el "meta" del evento (todo menos el content) en el shape legacy
// que usa events.js: { title, created_at, updated_at, openai_file_id, is_rules, is_index, ... }
export async function readEventMeta(slug) {
  const sql = getSql();
  const [row] = await sql`SELECT slug, title, is_rules, is_index, openai_file_id, created_at, updated_at FROM events WHERE slug = ${slug}`;
  if (!row) return null;
  return {
    title: row.title,
    is_rules: row.is_rules,
    is_index: row.is_index,
    openai_file_id: row.openai_file_id,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

// UPSERT del meta del evento. Si el evento no existe, lo crea con content=''.
export async function writeEventMeta(slug, meta) {
  const sql = getSql();
  await sql`
    INSERT INTO events (slug, title, is_rules, is_index, openai_file_id, created_at, updated_at)
    VALUES (
      ${slug},
      ${meta.title || slug},
      ${!!meta.is_rules},
      ${!!meta.is_index},
      ${meta.openai_file_id || null},
      ${meta.created_at || new Date().toISOString()},
      ${meta.updated_at || new Date().toISOString()}
    )
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      is_rules = EXCLUDED.is_rules,
      is_index = EXCLUDED.is_index,
      openai_file_id = EXCLUDED.openai_file_id,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function readEventContent(slug) {
  const sql = getSql();
  const [row] = await sql`SELECT content FROM events WHERE slug = ${slug}`;
  return row?.content || '';
}

// Si el evento no existe, lo crea con title=slug. Si existe, sólo actualiza el content.
export async function writeEventContent(slug, content) {
  const sql = getSql();
  await sql`
    INSERT INTO events (slug, title, content, updated_at)
    VALUES (${slug}, ${slug}, ${content ?? ''}, now())
    ON CONFLICT (slug) DO UPDATE SET
      content = EXCLUDED.content,
      updated_at = now()
  `;
}

export function makeSlug(input) {
  return slugify(input, { lower: true, strict: true, trim: true });
}

export { RULES_SLUG, INDEX_SLUG, MASTER_FILENAME };

// Reescribe referencias a /mapas/... como URLs absolutas si hay PUBLIC_BASE_URL.
// Si el texto ya tiene URL absoluta, el regex no matchea (idempotente).
function rewriteMapasUrls(text) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return text;
  return text.replace(/(MAPA_DE\s+"[^"]*"\s*(?:→|->)\s*)(\/mapas\/\S+)/g,
    (_, prefix, rel) => `${prefix}${base}${rel}`);
}

// Contenido que se sube a OpenAI por evento individual.
function buildFileContent(meta, content) {
  const body = rewriteMapasUrls(content.trim());
  if (meta.is_rules) {
    return `## Reglas comunes (aplican a todos los eventos)\n\n${body}\n`;
  }
  return `### ${meta.title}\n\n${body}\n`;
}

// Sube un archivo por evento.
// Slugs que NO se suben al vector store. Sus reglas viven en el system prompt
// del agente principal de Chatrace, no en archivos del VS — para evitar duplicar
// contenido y reducir costo de file_search.
const VS_EXCLUDE = new Set([RULES_SLUG, 'agente-reservas']);

// Slugs reservados — no se pueden usar como nombre de evento. Cubre los slugs
// internos y los que se usan para archivos generados (lista-eventos, etc).
export const RESERVED_SLUGS = new Set([
  RULES_SLUG,
  INDEX_SLUG,
  'agente-reservas',
  'lista-eventos',
]);

export async function syncEventFile(slug) {
  const meta = await readEventMeta(slug);
  if (!meta) throw new Error(`No existe el evento ${slug}`);

  // Si el slug está en la blocklist, no subir al VS. Si tenía un file_id previo,
  // dejarlo como null para que `meta.json` no quede con una referencia rota.
  if (VS_EXCLUDE.has(slug)) {
    if (meta.openai_file_id) {
      await writeEventMeta(slug, { ...meta, openai_file_id: null, updated_at: new Date().toISOString() });
    }
    return null;
  }

  const content = await readEventContent(slug);
  const fullContent = buildFileContent(meta, content);

  const tmpDir = path.join(MASTER_DIR, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${slug}.md`);
  await fs.writeFile(tmpPath, fullContent);

  const filename = meta.is_rules ? 'reglas-comunes.md' : `${slug}.md`;
  const newFileId = await syncFileToVectorStore({
    filePath: tmpPath,
    filename,
    previousFileId: meta.openai_file_id || null,
  });

  await writeEventMeta(slug, {
    ...meta,
    openai_file_id: newFileId,
    updated_at: new Date().toISOString(),
  });

  await fs.unlink(tmpPath).catch(() => {});
  return newFileId;
}

// LEGACY — el catálogo `terco-tour-catalogo.md` ya no se sube al VS.
// `lista-eventos.md` cumple la función de "índice" y los detalles vienen de los
// archivos individuales por evento. Esta función queda como no-op para no
// romper llamadas existentes desde events.js (POST/PUT/DELETE/import).
export async function syncCatalogFile() {
  return null;
}

// Alias legacy: syncIndexFile ahora sube el catálogo.
export async function syncIndexFile() { return await syncCatalogFile(); }
// Alias legacy para compat con llamadas internas.
export async function syncMasterFile() { return await syncCatalogFile(); }

// Devuelve TODOS los eventos en una sola query, ordenados por display_order
// (los que tienen) y después alfabéticamente por slug. Cada evento incluye su
// content completo y un `meta` con el shape legacy.
export async function loadAllEventsInOrder() {
  const sql = getSql();
  const rows = await sql`
    SELECT slug, title, content, is_rules, is_index, openai_file_id, display_order, created_at, updated_at
    FROM events
    ORDER BY (display_order IS NULL), display_order ASC, slug ASC
  `;
  const master = await readMasterMeta();
  const events = rows.map((r) => ({
    slug: r.slug,
    title: r.title || r.slug,
    content: r.content || '',
    meta: {
      title: r.title || r.slug,
      is_rules: r.is_rules,
      is_index: r.is_index,
      openai_file_id: r.openai_file_id,
      created_at: r.created_at?.toISOString?.() || r.created_at,
      updated_at: r.updated_at?.toISOString?.() || r.updated_at,
    },
  }));
  return { master, events };
}

// Construye el .md ligero del catálogo — sólo índice + preámbulo + reglas.
// Es lo que se sube al vector store como `terco-tour-catalogo.md`. Cada evento
// ya está como archivo individual en el VS, así que NO hace falta duplicar su
// contenido acá. Este archivo sirve de "tabla de contenidos" + reglas globales
// que el agente puede citar sin tener que abrir 77 archivos.
export async function buildCatalogIndexMd() {
  const { master, events } = await loadAllEventsInOrder();
  const regularEvents = events.filter((e) => !e.meta.is_rules && !e.meta.is_index);
  const rules = events.find((e) => e.meta.is_rules);

  const titles = regularEvents.map((e) => e.title).sort((a, b) => a.localeCompare(b, 'es'));
  const lines = [
    '# Terco Tour — Catálogo de eventos',
    '',
    'Listado actualizado de todos los eventos operativos. Usá este archivo para responder consultas tipo "qué eventos tienen", "qué hay disponible", "shows próximos". El detalle de cada evento (precios, zonas, mapa) está en su archivo individual `{slug}.md`.',
    '',
    '## Índice de eventos',
    '',
    ...titles.map((t) => `- ${t}`),
    '',
    `**Total de eventos:** ${titles.length}`,
  ];

  if (master.preamble && master.preamble.trim()) {
    lines.push('', master.preamble.trim());
  }

  if (rules) {
    lines.push('', '---', '', '## Reglas comunes (aplican a todos los eventos)', '', rules.content.trim());
  }

  return lines.join('\n') + '\n';
}

// Construye el .md "lista de eventos" — solo títulos, ultra-compacto.
// Pensado para ir DENTRO del system prompt del agente (no en el vector store):
// el agente "ve" toda la lista sin tener que llamar file_search para preguntas
// como "qué eventos tienen" / "qué hay disponible". Ahorra calls + chunks.
//
// Distingue eventos con info cargada (tienen content.md no vacío) de los que
// están registrados pero sin info operativa todavía (los marca aparte).
export async function buildListaEventosMd() {
  const { events } = await loadAllEventsInOrder();
  // Slugs reservados que no son eventos comerciales.
  const NON_EVENT = new Set([RULES_SLUG, INDEX_SLUG, 'agente-reservas']);
  const regulares = events.filter((e) =>
    !e.meta.is_rules && !e.meta.is_index && !NON_EVENT.has(e.slug)
  );

  const conInfo = [];
  const sinInfo = [];
  for (const e of regulares) {
    const trimmed = (e.content || '').trim();
    // "Sin info cargada" = content.md vacío o casi vacío.
    if (!trimmed || trimmed.length < 20 || trimmed === '---') {
      sinInfo.push(e.title);
    } else {
      conInfo.push(e.title);
    }
  }
  conInfo.sort((a, b) => a.localeCompare(b, 'es'));
  sinInfo.sort((a, b) => a.localeCompare(b, 'es'));

  const lines = [
    '# Lista de eventos disponibles',
    '',
    `Total: ${conInfo.length} eventos con info operativa.`,
    '',
    '## Eventos disponibles',
    '',
    ...conInfo.map((t) => `- ${t}`),
  ];

  if (sinInfo.length) {
    lines.push(
      '',
      '## Eventos sin info cargada',
      '',
      'Estos eventos existen en el sistema pero no tienen info operativa todavía. Para consultas sobre ellos, derivar al asesor.',
      '',
      ...sinInfo.map((t) => `- ${t}`),
    );
  }

  lines.push('', `_Última actualización: ${new Date().toISOString()}_`, '');
  return lines.join('\n');
}

// Persiste la lista de eventos a disco. Se invoca desde POST/PUT/DELETE de
// eventos para mantener el archivo sincronizado sin trabajo manual.
export async function writeListaEventos() {
  const md = await buildListaEventosMd();
  await fs.mkdir(MASTER_DIR, { recursive: true });
  await fs.writeFile(path.join(MASTER_DIR, 'lista-eventos.md'), md);
  return md;
}

// Sube `lista-eventos.md` al vector store y persiste el file_id en master meta.
// Después del upload, hace `dedupeByFilename` para eliminar cualquier huérfano
// con el mismo nombre — esto previene que el meta.json desactualizado entre
// deploys deje archivos huérfanos (bug de abril 2026 con easypanel).
export async function syncListaEventosFile() {
  const md = await buildListaEventosMd();
  const tmpDir = path.join(MASTER_DIR, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, 'lista-eventos.md');
  await fs.writeFile(tmpPath, md);
  // También dejarla en data/_master/ para el endpoint /api/events/lista.
  await fs.writeFile(path.join(MASTER_DIR, 'lista-eventos.md'), md);

  const master = await readMasterMeta();
  const newFileId = await syncFileToVectorStore({
    filePath: tmpPath,
    filename: 'lista-eventos.md',
    previousFileId: master.lista_file_id || null,
  });

  // Sweep adicional: cualquier otra `lista-eventos.md` que quedó huérfana
  // (de deploys anteriores donde el meta no estaba sincronizado).
  try {
    const removed = await dedupeByFilename('lista-eventos.md', newFileId);
    if (removed.length) {
      console.log(`syncListaEventosFile: dedupe eliminó ${removed.length} huérfano(s):`, removed);
    }
  } catch (err) {
    console.warn('dedupeByFilename falló:', err.message);
  }

  await writeMasterMeta({
    ...master,
    lista_file_id: newFileId,
    updated_at: new Date().toISOString(),
  });

  await fs.unlink(tmpPath).catch(() => {});
  return newFileId;
}

// Construye el .md completo (preview) — índice + preamble + eventos + reglas.
// Sólo se usa en GET /api/events/preview para que el humano vea el doc
// ensamblado, NO se sube al vector store.
export async function buildFullMd() {
  const { master, events } = await loadAllEventsInOrder();
  const regularEvents = events.filter((e) => !e.meta.is_rules && !e.meta.is_index);
  const rules = events.find((e) => e.meta.is_rules);

  const titles = regularEvents.map((e) => e.title).sort((a, b) => a.localeCompare(b, 'es'));
  const indexBlock = [
    '# Terco Tour — Catálogo de eventos',
    '',
    'Listado actualizado de todos los eventos operativos. Usá este archivo para responder consultas tipo "qué eventos tienen", "qué hay disponible", "shows próximos".',
    '',
    '## Índice de eventos',
    '',
    ...titles.map((t) => `- ${t}`),
    '',
    `**Total de eventos:** ${titles.length}`,
  ].join('\n');

  const preamble = master.preamble && master.preamble.trim()
    ? `${indexBlock}\n\n${master.preamble.trim()}`
    : indexBlock;

  return assembleMultiEventMd({
    preamble,
    events: regularEvents.map((e) => ({ title: e.title, content: e.content })),
    footer: rules ? `## Reglas comunes (aplican a todos los eventos)\n\n${rules.content}` : '',
  });
}

// Sincroniza todos los eventos (uno por archivo) + el catálogo, con progreso.
// onProgress recibe { type, current, total, filename, ... } estilo NDJSON.
export async function syncAllToVectorStore(onProgress) {
  const emit = (e) => { try { onProgress?.(e); } catch {} };
  const { events } = await loadAllEventsInOrder();
  const syncable = events.filter((e) => !e.meta.is_index);
  const total = syncable.length + 1; // +1 por el catálogo
  emit({ type: 'start', total });

  const CONCURRENCY = 6;
  const keep = new Set();
  const errors = [];
  let done = 0;
  let okEvents = 0;
  let okRules = false;

  async function worker(startIdx) {
    for (let i = startIdx; i < syncable.length; i += CONCURRENCY) {
      const ev = syncable[i];
      const filename = ev.meta.is_rules ? 'reglas-comunes.md' : `${ev.slug}.md`;
      try {
        const id = await syncEventFile(ev.slug);
        keep.add(id);
        if (ev.meta.is_rules) okRules = true;
        else okEvents += 1;
      } catch (err) {
        console.error(`sync falló para ${ev.slug}:`, err.message);
        errors.push({ slug: ev.slug, error: err.message });
        if (ev.meta.openai_file_id) keep.add(ev.meta.openai_file_id);
      }
      done += 1;
      emit({ type: 'progress', current: done, total, filename });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));

  // Catálogo al final (necesita titles ya actualizados).
  let catalogId = null;
  try {
    catalogId = await syncCatalogFile();
    keep.add(catalogId);
  } catch (err) {
    console.error('syncCatalogFile:', err.message);
    errors.push({ file: MASTER_FILENAME, error: err.message });
    const master = await readMasterMeta();
    if (master.openai_file_id) keep.add(master.openai_file_id);
  }
  done += 1;
  emit({ type: 'progress', current: done, total, filename: MASTER_FILENAME });

  emit({ type: 'cleanup' });
  try {
    await cleanupOrphans(keep);
  } catch (err) {
    console.warn('cleanupOrphans:', err.message);
  }

  await writeMasterMeta({
    ...(await readMasterMeta()),
    updated_at: new Date().toISOString(),
  });

  const result = {
    ok: errors.length === 0,
    events: okEvents,
    rules: okRules,
    catalog: !!catalogId,
    openai_file_id: catalogId,
    total: syncable.filter((e) => !e.meta.is_rules).length,
    errors,
  };
  emit({ type: 'done', result });
  return result;
}

async function pullFromSingleMaster(masterFile, emit) {
  emit({ type: 'start', total: 1 });
  let content;
  try {
    content = await downloadFileContent(masterFile.id);
  } catch (err) {
    emit({ type: 'error', error: err.message });
    throw err;
  }
  emit({ type: 'progress', current: 1, total: 1, filename: masterFile.filename });
  emit({ type: 'writing' });

  const parsed = parseMultiEventMd(content);

  // Wipe DB.
  const sql = getSql();
  await sql`DELETE FROM events`;

  const now = new Date().toISOString();
  const order = [];
  const imported = [];
  const usedSlugs = new Set();

  for (const ev of parsed.events) {
    let slug = makeSlug(ev.title) || `evento-${order.length + 1}`;
    const base = slug;
    let i = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${i++}`;
    usedSlugs.add(slug);
    await writeEventMeta(slug, {
      title: ev.title,
      is_rules: false,
      created_at: now,
      updated_at: now,
    });
    await writeEventContent(slug, ev.content);
    order.push(slug);
    imported.push({ slug, title: ev.title });
  }

  let rulesFound = false;
  if (parsed.footer) {
    const rulesContent = parsed.footer
      .replace(/^##\s+Reglas comunes[^\n]*\n*/i, '')
      .trim();
    if (rulesContent) {
      await writeEventMeta(RULES_SLUG, {
        title: 'Reglas comunes',
        is_rules: true,
        created_at: now,
        updated_at: now,
      });
      await writeEventContent(RULES_SLUG, rulesContent);
      order.push(RULES_SLUG);
      imported.push({ slug: RULES_SLUG, title: 'Reglas comunes' });
      rulesFound = true;
    }
  }

  await writeMasterMeta({
    preamble: '',
    order,
    openai_file_id: masterFile.id,
    updated_at: now,
  });

  const result = {
    ok: true,
    events: parsed.events.length,
    rules: rulesFound,
    index: true,
    total_files: 1,
    imported,
    errors: [],
  };
  emit({ type: 'done', result });
  return result;
}

// Descarga del vector store y reconstruye lo local.
// Si existe el archivo único (MASTER_FILENAME), lo usa. Fallback: multi-archivo legacy.
export async function pullFromVectorStore(onProgress) {
  const emit = (e) => { try { onProgress?.(e); } catch {} };
  emit({ type: 'listing' });
  const files = await listVectorStoreFiles();

  const catalogFile = files.find((f) => f.filename === MASTER_FILENAME);

  // Archivos derivados que NO son eventos — generados automáticamente desde el
  // repo, no se "pullean" porque se regeneran solos al sincronizar eventos.
  const DERIVED = new Set([MASTER_FILENAME, 'lista-eventos.md']);
  const otherFiles = files.filter((f) => !DERIVED.has(f.filename));

  // Si sólo existe el catálogo (estado single-file), parsearlo.
  if (catalogFile && otherFiles.length === 0) {
    return await pullFromSingleMaster(catalogFile, emit);
  }

  // Multi-archivo: ignorar archivos derivados (catálogo + lista).
  const workFiles = otherFiles;
  emit({ type: 'start', total: workFiles.length });

  const CONCURRENCY = 8;
  const results = new Array(workFiles.length);
  const errors = [];
  let done = 0;

  async function worker(startIdx) {
    for (let i = startIdx; i < workFiles.length; i += CONCURRENCY) {
      const f = workFiles[i];
      try {
        const content = await downloadFileContent(f.id);
        results[i] = { file: f, content };
      } catch (err) {
        console.error(`pull: no pude descargar ${f.filename} (${f.id}):`, err.message);
        errors.push({ id: f.id, filename: f.filename, error: err.message });
        results[i] = null;
      }
      done += 1;
      emit({ type: 'progress', current: done, total: workFiles.length, filename: f.filename });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));

  emit({ type: 'writing' });

  // Wipe DB SOLO después de que todas las descargas en memoria estén ok.
  const sql = getSql();
  await sql`DELETE FROM events`;

  const now = new Date().toISOString();
  const order = [];
  let rulesFound = false;
  let indexFound = false;
  const imported = [];

  for (const r of results) {
    if (!r) continue;
    const { file: f, content } = r;
    const base = (f.filename || '').replace(/\.md$/i, '');

    if (base === 'indice-eventos' || base === INDEX_SLUG) {
      await writeEventMeta(INDEX_SLUG, {
        title: 'Índice de eventos',
        is_index: true,
        created_at: now,
        updated_at: now,
        openai_file_id: f.id,
      });
      await writeEventContent(INDEX_SLUG, content);
      indexFound = true;
      continue;
    }

    if (base === 'reglas-comunes' || base === RULES_SLUG) {
      const body = content.replace(/^##\s+Reglas comunes[^\n]*\n+/i, '').trim();
      await writeEventMeta(RULES_SLUG, {
        title: 'Reglas comunes',
        is_rules: true,
        created_at: now,
        updated_at: now,
        openai_file_id: f.id,
      });
      await writeEventContent(RULES_SLUG, body);
      rulesFound = true;
      imported.push({ slug: RULES_SLUG, title: 'Reglas comunes' });
      continue;
    }

    const slug = makeSlug(base) || base;
    let title = base;
    let body = content;
    const m = content.match(/^###\s+(.+?)\n+([\s\S]*)$/);
    if (m) {
      title = m[1].trim();
      body = m[2].trim();
    } else {
      body = content.trim();
    }
    await writeEventMeta(slug, {
      title,
      is_rules: false,
      created_at: now,
      updated_at: now,
      openai_file_id: f.id,
    });
    await writeEventContent(slug, body);
    order.push(slug);
    imported.push({ slug, title });
  }

  if (rulesFound) order.push(RULES_SLUG);

  await writeMasterMeta({
    preamble: '',
    order,
    openai_file_id: catalogFile?.id || null,
    updated_at: now,
  });

  const result = {
    ok: true,
    events: order.filter((s) => s !== RULES_SLUG).length,
    rules: rulesFound,
    index: indexFound,
    catalog: !!catalogFile,
    total_files: workFiles.length + (catalogFile ? 1 : 0),
    imported,
    errors,
  };
  emit({ type: 'done', result });
  return result;
}

// Elimina un evento de OpenAI y de la DB.
// Nota: las imágenes en `public/mapas/<slug>/` NO se borran automáticamente —
// quedan disponibles por si se quiere recuperar el evento.
export async function deleteEventCompletely(slug) {
  const sql = getSql();
  const meta = await readEventMeta(slug);
  if (!meta) return;
  if (meta.openai_file_id) {
    await deleteFromVectorStore(meta.openai_file_id);
  }
  await sql`DELETE FROM events WHERE slug = ${slug}`;
}

export { DATA_DIR, MASTER_DIR };
