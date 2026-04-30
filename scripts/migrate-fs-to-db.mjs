// Migra los datos del filesystem (data/eventos/*) a Postgres.
// Idempotente: usa UPSERT, podés correrlo varias veces sin perder nada.
//
// Uso:
//   node --env-file=.env scripts/migrate-fs-to-db.mjs

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSql, runMigrations, closeSql } from '../src/services/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'eventos');
const MASTER_DIR = path.join(ROOT, 'data', '_master');

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return null; }
}

async function readText(p) {
  try { return await fs.readFile(p, 'utf8'); }
  catch { return ''; }
}

async function main() {
  console.log('=== Migrando filesystem → Postgres ===');
  console.log('');

  // 0. Asegurar schema.
  console.log('[1/3] Aplicando migraciones SQL...');
  await runMigrations();
  console.log('');

  const sql = getSql();

  // 1. Migrar master_settings desde data/_master/meta.json.
  console.log('[2/3] Migrando master_settings...');
  const masterMeta = (await readJson(path.join(MASTER_DIR, 'meta.json'))) || {};
  await sql`
    UPDATE master_settings SET
      preamble = ${masterMeta.preamble || ''},
      catalog_file_id = ${masterMeta.openai_file_id || null},
      lista_file_id = ${masterMeta.lista_file_id || null},
      updated_at = ${masterMeta.updated_at ? new Date(masterMeta.updated_at) : new Date()}
    WHERE id = 1
  `;
  console.log(`  ✓ preamble: ${(masterMeta.preamble || '').length} chars`);
  console.log(`  ✓ catalog_file_id: ${masterMeta.openai_file_id || '(null)'}`);
  console.log(`  ✓ lista_file_id: ${masterMeta.lista_file_id || '(null)'}`);
  console.log('');

  // 2. Migrar cada evento desde data/eventos/<slug>/.
  console.log('[3/3] Migrando eventos...');
  const order = masterMeta.order || [];
  const orderMap = new Map(order.map((slug, i) => [slug, i]));

  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    console.log('  (no existe data/eventos/, salteando)');
    await closeSql();
    return;
  }
  const slugs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !/ \d+$/.test(e.name))
    .map((e) => e.name)
    .sort();

  let imported = 0, skipped = 0;
  for (const slug of slugs) {
    const meta = await readJson(path.join(DATA_DIR, slug, 'meta.json'));
    if (!meta) { skipped++; continue; }
    const content = await readText(path.join(DATA_DIR, slug, 'content.md'));
    const displayOrder = orderMap.has(slug) ? orderMap.get(slug) : null;

    await sql`
      INSERT INTO events (slug, title, content, is_rules, is_index, openai_file_id, display_order, created_at, updated_at)
      VALUES (
        ${slug},
        ${meta.title || slug},
        ${content || ''},
        ${!!meta.is_rules},
        ${!!meta.is_index},
        ${meta.openai_file_id || null},
        ${displayOrder},
        ${meta.created_at ? new Date(meta.created_at) : new Date()},
        ${meta.updated_at ? new Date(meta.updated_at) : new Date()}
      )
      ON CONFLICT (slug) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        is_rules = EXCLUDED.is_rules,
        is_index = EXCLUDED.is_index,
        openai_file_id = EXCLUDED.openai_file_id,
        display_order = EXCLUDED.display_order,
        updated_at = EXCLUDED.updated_at
    `;
    imported++;
  }
  console.log(`  ✓ ${imported} eventos importados (${skipped} salteados sin meta.json)`);
  console.log('');

  // Verificación final.
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM events`;
  console.log(`=== Resultado ===`);
  console.log(`Eventos en DB: ${count}`);

  await closeSql();
}

main().catch((err) => { console.error(err); process.exit(1); });
