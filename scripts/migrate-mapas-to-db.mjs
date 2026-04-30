// Importa imágenes desde public/mapas/<slug>/<file> a la tabla event_media.
// Idempotente: usa ON CONFLICT DO NOTHING, podés correrlo varias veces.
//
// Uso (después de tener DATABASE_URL configurada):
//   node --env-file=.env scripts/migrate-mapas-to-db.mjs
//   node --env-file=.env scripts/migrate-mapas-to-db.mjs --overwrite  (re-importa pisando lo que esté en DB)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSql, runMigrations, closeSql } from '../src/services/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPAS_DIR = path.resolve(__dirname, '../public/mapas');

const OVERWRITE = process.argv.includes('--overwrite');

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function main() {
  console.log('=== Migrando public/mapas/ → event_media (Postgres) ===\n');

  console.log('[1/2] Aplicando migraciones SQL...');
  await runMigrations();

  const sql = getSql();

  console.log('\n[2/2] Importando imágenes...');
  let entries;
  try {
    entries = await fs.readdir(MAPAS_DIR, { withFileTypes: true });
  } catch {
    console.log('  No existe public/mapas/, nada para importar.');
    await closeSql();
    return;
  }

  let imported = 0, skipped = 0, total = 0;

  for (const slugEntry of entries) {
    if (!slugEntry.isDirectory()) continue;
    if (slugEntry.name.startsWith('.') || / \d+$/.test(slugEntry.name)) continue; // ignorar oculto y duplicados iCloud

    const slug = slugEntry.name;
    const slugDir = path.join(MAPAS_DIR, slug);
    const files = await fs.readdir(slugDir);

    for (const filename of files) {
      if (filename.startsWith('.')) continue;
      const ext = path.extname(filename).toLowerCase();
      if (!EXT_TO_MIME[ext]) continue;

      total++;
      const filePath = path.join(slugDir, filename);
      const buf = await fs.readFile(filePath);
      const contentType = EXT_TO_MIME[ext];

      if (OVERWRITE) {
        await sql`
          INSERT INTO event_media (slug, filename, content_type, data, uploaded_at)
          VALUES (${slug}, ${filename}, ${contentType}, ${buf}, now())
          ON CONFLICT (slug, filename) DO UPDATE SET
            content_type = EXCLUDED.content_type,
            data = EXCLUDED.data,
            uploaded_at = now()
        `;
        imported++;
      } else {
        const result = await sql`
          INSERT INTO event_media (slug, filename, content_type, data, uploaded_at)
          VALUES (${slug}, ${filename}, ${contentType}, ${buf}, now())
          ON CONFLICT (slug, filename) DO NOTHING
        `;
        if (result.count > 0) imported++;
        else skipped++;
      }

      if ((imported + skipped) % 10 === 0) {
        console.log(`  ${imported + skipped}/${total}...`);
      }
    }
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM event_media`;
  const [{ size }] = await sql`SELECT pg_size_pretty(pg_relation_size('event_media'))::text AS size`;

  console.log(`\n=== Resultado ===`);
  console.log(`Total archivos en FS:        ${total}`);
  console.log(`Importadas:                  ${imported}`);
  console.log(`Salteadas (ya estaban en DB): ${skipped}`);
  console.log(`Total filas en event_media:  ${count}`);
  console.log(`Tamaño de la tabla:          ${size}`);

  await closeSql();
}

main().catch((err) => { console.error(err); process.exit(1); });
