// Renombra los archivos dentro de public/mapas/<slug>/ a imagen1.ext, imagen2.ext, ...
// en el orden en que aparecen en el content.md del evento. Reescribe content.md
// para reflejar los nombres nuevos.
//
// Asume que la reorganización por evento (reorg-mapas-por-evento.mjs) ya corrió.
// Idempotente: archivos que ya se llaman imagenN.ext no se tocan.
//
// Uso:
//   node scripts/rename-mapas-secuencial.mjs          (aplica)
//   node scripts/rename-mapas-secuencial.mjs --dry    (sólo reporta)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'eventos');
const MAPAS_DIR = path.join(ROOT, 'public', 'mapas');

const DRY = process.argv.includes('--dry');

// Captura /mapas/<slug>/<archivo>. El archivo NO debe tener más slashes.
const URL_RE = /\/mapas\/([^\s"'\/)]+)\/([^\s"'\/)]+)/g;

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  let totalRenamed = 0;
  let totalEvents = 0;

  for (const slug of slugs) {
    const mdPath = path.join(DATA_DIR, slug, 'content.md');
    if (!(await pathExists(mdPath))) continue;
    const orig = await fs.readFile(mdPath, 'utf8');

    // Extraer los archivos referenciados para ESTE slug, en orden de aparición.
    // Preservar duplicados (dos refs al mismo archivo = mismo nombre nuevo).
    const refsInOrder = [];
    const seen = new Map(); // oldName → newName
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(orig)) !== null) {
      const refSlug = m[1];
      const file = m[2];
      if (refSlug !== slug) continue; // ref a otro evento — raro, skip
      if (!refsInOrder.includes(file)) refsInOrder.push(file);
    }

    if (!refsInOrder.length) continue;

    // Asignar nombres nuevos imagen1.ext, imagen2.ext.
    let n = 1;
    for (const oldFile of refsInOrder) {
      const ext = path.extname(oldFile).toLowerCase();
      const newFile = `imagen${n}${ext}`;
      n++;
      if (oldFile === newFile) { seen.set(oldFile, newFile); continue; }
      seen.set(oldFile, newFile);
    }

    // Aplicar cambios: rename físico + reescribir content.md.
    let changed = false;
    let newMd = orig;
    for (const [oldFile, newFile] of seen) {
      if (oldFile === newFile) continue;
      const oldPath = path.join(MAPAS_DIR, slug, oldFile);
      const newPath = path.join(MAPAS_DIR, slug, newFile);
      if (!(await pathExists(oldPath))) {
        console.log(`  ⚠  ${slug}/${oldFile} referenciado pero no existe`);
        continue;
      }
      if (!DRY) {
        // Evitar colisión: si ya existe el destino (p.ej. por corrida previa),
        // borrar el viejo y seguir.
        if (await pathExists(newPath)) {
          await fs.unlink(oldPath);
        } else {
          await fs.rename(oldPath, newPath);
        }
      }
      // Reemplazar en content.md todas las ocurrencias del path viejo.
      const needle = `/mapas/${slug}/${oldFile}`;
      const replace = `/mapas/${slug}/${newFile}`;
      if (newMd.includes(needle)) {
        newMd = newMd.split(needle).join(replace);
        changed = true;
      }
      totalRenamed++;
      console.log(`  ${slug}: ${oldFile} → ${newFile}`);
    }

    if (changed && !DRY) {
      await fs.writeFile(mdPath, newMd);
    }
    if (changed) totalEvents++;
  }

  console.log(`\n=== Resultado ===`);
  console.log(`Eventos afectados: ${totalEvents}`);
  console.log(`Archivos renombrados: ${totalRenamed}`);
  if (DRY) console.log(`[dry-run] nada aplicado.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
