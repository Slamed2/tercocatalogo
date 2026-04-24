// Gestión multi-archivo:
//  - Un archivo por evento en el vector store (`{slug}.md`).
//  - Un archivo base `terco-tour-catalogo.md` que tiene índice + reglas comunes
//    (sirve como referencia holística del catálogo).
// Local: una carpeta por evento para editar.

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import slugify from 'slugify';
import { fileURLToPath } from 'url';
import { assembleMultiEventMd, parseMultiEventMd } from './mdsplit.js';
import {
  syncFileToVectorStore,
  cleanupOrphans,
  deleteFromVectorStore,
  listVectorStoreFiles,
  downloadFileContent,
} from './openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data/eventos');
const MASTER_DIR = path.join(__dirname, '../../data/_master');
const RULES_SLUG = 'reglas-comunes';
const INDEX_SLUG = '_indice';
const MASTER_FILENAME = 'terco-tour-catalogo.md';

export async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MASTER_DIR, { recursive: true });
}

export async function readMasterMeta() {
  try {
    const raw = await fs.readFile(path.join(MASTER_DIR, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { preamble: '', order: [], updated_at: null };
  }
}

export async function writeMasterMeta(meta) {
  await fs.mkdir(MASTER_DIR, { recursive: true });
  await fs.writeFile(path.join(MASTER_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function readEventMeta(slug) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, slug, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeEventMeta(slug, meta) {
  await fs.mkdir(path.join(DATA_DIR, slug), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, slug, 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function readEventContent(slug) {
  try {
    return await fs.readFile(path.join(DATA_DIR, slug, 'content.md'), 'utf8');
  } catch {
    return '';
  }
}

export async function writeEventContent(slug, content) {
  const dir = path.join(DATA_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'content.md'), content ?? '');
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
export async function syncEventFile(slug) {
  const meta = await readEventMeta(slug);
  if (!meta) throw new Error(`No existe el evento ${slug}`);
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

// Sube el archivo base (catálogo) con índice + reglas comunes.
export async function syncCatalogFile() {
  const master = await readMasterMeta();
  const content = rewriteMapasUrls(await buildCatalogIndexMd());

  const tmpDir = path.join(MASTER_DIR, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, MASTER_FILENAME);
  await fs.writeFile(tmpPath, content);

  const newFileId = await syncFileToVectorStore({
    filePath: tmpPath,
    filename: MASTER_FILENAME,
    previousFileId: master.openai_file_id || null,
  });

  await writeMasterMeta({
    ...master,
    openai_file_id: newFileId,
    updated_at: new Date().toISOString(),
  });

  await fs.unlink(tmpPath).catch(() => {});
  return newFileId;
}

// Alias legacy: syncIndexFile ahora sube el catálogo.
export async function syncIndexFile() { return await syncCatalogFile(); }
// Alias legacy para compat con llamadas internas.
export async function syncMasterFile() { return await syncCatalogFile(); }

export async function loadAllEventsInOrder() {
  const master = await readMasterMeta();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const ordered = [];
  const seen = new Set();
  for (const s of master.order || []) {
    if (slugs.includes(s)) { ordered.push(s); seen.add(s); }
  }
  ordered.push(...slugs.filter((s) => !seen.has(s)));

  const events = [];
  for (const slug of ordered) {
    const meta = await readEventMeta(slug);
    if (!meta) continue;
    const content = await readEventContent(slug);
    events.push({ slug, title: meta.title || slug, content, meta });
  }
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

  // Wipe local.
  const prev = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of prev) {
    if (e.isDirectory()) {
      await fs.rm(path.join(DATA_DIR, e.name), { recursive: true, force: true });
    }
  }

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
    const dir = path.join(DATA_DIR, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'content.md'), ev.content);
    await writeEventMeta(slug, {
      title: ev.title,
      is_rules: false,
      created_at: now,
      updated_at: now,
    });
    order.push(slug);
    imported.push({ slug, title: ev.title });
  }

  let rulesFound = false;
  if (parsed.footer) {
    const rulesContent = parsed.footer
      .replace(/^##\s+Reglas comunes[^\n]*\n*/i, '')
      .trim();
    if (rulesContent) {
      const dir = path.join(DATA_DIR, RULES_SLUG);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'content.md'), rulesContent);
      await writeEventMeta(RULES_SLUG, {
        title: 'Reglas comunes',
        is_rules: true,
        created_at: now,
        updated_at: now,
      });
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
  const otherFiles = files.filter((f) => f.filename !== MASTER_FILENAME);

  // Si sólo existe el catálogo (estado single-file), parsearlo.
  if (catalogFile && otherFiles.length === 0) {
    return await pullFromSingleMaster(catalogFile, emit);
  }

  // Multi-archivo: ignorar el catálogo (es derivado).
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

  // Wipe local SOLO después de que todas las descargas en memoria estén ok.
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) {
      await fs.rm(path.join(DATA_DIR, e.name), { recursive: true, force: true });
    }
  }

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
      const dir = path.join(DATA_DIR, INDEX_SLUG);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'content.md'), content);
      await writeEventMeta(INDEX_SLUG, {
        title: 'Índice de eventos',
        is_index: true,
        created_at: now,
        updated_at: now,
        openai_file_id: f.id,
      });
      indexFound = true;
      continue;
    }

    if (base === 'reglas-comunes' || base === RULES_SLUG) {
      const body = content.replace(/^##\s+Reglas comunes[^\n]*\n+/i, '').trim();
      const dir = path.join(DATA_DIR, RULES_SLUG);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'content.md'), body);
      await writeEventMeta(RULES_SLUG, {
        title: 'Reglas comunes',
        is_rules: true,
        created_at: now,
        updated_at: now,
        openai_file_id: f.id,
      });
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
    const dir = path.join(DATA_DIR, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'content.md'), body);
    await writeEventMeta(slug, {
      title,
      is_rules: false,
      created_at: now,
      updated_at: now,
      openai_file_id: f.id,
    });
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

// Elimina un evento de OpenAI y local.
export async function deleteEventCompletely(slug) {
  const meta = await readEventMeta(slug);
  if (!meta) return;
  if (meta.openai_file_id) {
    await deleteFromVectorStore(meta.openai_file_id);
  }
  await fs.rm(path.join(DATA_DIR, slug), { recursive: true, force: true });
  const master = await readMasterMeta();
  const order = (master.order || []).filter((s) => s !== slug);
  await writeMasterMeta({ ...master, order });
}

export { DATA_DIR, MASTER_DIR };
