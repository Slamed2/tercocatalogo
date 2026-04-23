// Mueve los mapas planos en public/mapas/*.png a subcarpetas por evento:
// public/mapas/<slug>/<archivo>. Reescribe los content.md locales con las
// nuevas URLs. NO toca el vector store — para eso correr luego un resync.
//
// Uso:
//   node scripts/reorg-mapas-por-evento.mjs          (aplica cambios)
//   node scripts/reorg-mapas-por-evento.mjs --dry    (sólo reporta)
//
// Heurística:
//  - Un mismo archivo plano puede ser referenciado por varios eventos.
//    En ese caso se COPIA (no se mueve) a cada subcarpeta, para que cada
//    evento sea autocontenido.
//  - Después de procesar todos los eventos, los archivos planos que quedaron
//    SIN referencia se dejan como están (huérfanos) — no los borro por las
//    dudas. Al final el script lista los huérfanos para que decidas.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'eventos');
const MAPAS_DIR = path.join(ROOT, 'public', 'mapas');

const DRY = process.argv.includes('--dry');

// Matchea /mapas/<archivo> (absoluto o relativo). El <archivo> NO debe
// contener slash (= ya migrado). Usamos un lookahead para rechazar subcarpeta.
const URL_RE = /(https?:\/\/[^\s"')]+)?\/mapas\/([^\s"'\/)]+)/g;

function log(...args) { console.log(...args); }

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // archivo plano → lista de slugs que lo referencian
  const refs = new Map();
  // slug → {contentBefore, contentAfter, usedFiles}
  const plan = new Map();

  for (const slug of slugs) {
    const mdPath = path.join(DATA_DIR, slug, 'content.md');
    if (!(await pathExists(mdPath))) continue;
    const orig = await fs.readFile(mdPath, 'utf8');
    const used = [];
    const nuevo = orig.replace(URL_RE, (_match, prefix, file) => {
      used.push(file);
      const ref = refs.get(file) || [];
      if (!ref.includes(slug)) ref.push(slug);
      refs.set(file, ref);
      return `${prefix || ''}/mapas/${slug}/${file}`;
    });
    if (orig !== nuevo) {
      plan.set(slug, { mdPath, before: orig, after: nuevo, used });
    }
  }

  log(`\n=== Plan ===`);
  log(`Eventos con refs planas: ${plan.size}`);
  log(`Archivos referenciados distintos: ${refs.size}`);

  const dupes = [...refs.entries()].filter(([, s]) => s.length > 1);
  if (dupes.length) {
    log(`\nArchivos compartidos por varios eventos (se copiarán a cada uno):`);
    for (const [f, ss] of dupes) log(`  ${f} → ${ss.join(', ')}`);
  }

  if (DRY) {
    log(`\n[dry-run] no se aplicó nada. Re-corré sin --dry.`);
    return;
  }

  let moved = 0;
  let copied = 0;
  for (const [file, ownerSlugs] of refs) {
    const src = path.join(MAPAS_DIR, file);
    if (!(await pathExists(src))) {
      log(`  ⚠  ${file} referenciado pero no existe en public/mapas/`);
      continue;
    }
    // Primer owner: mover. Resto: copiar.
    for (let i = 0; i < ownerSlugs.length; i++) {
      const slug = ownerSlugs[i];
      const destDir = path.join(MAPAS_DIR, slug);
      await fs.mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, file);
      if (await pathExists(dest)) continue; // ya existe en la subcarpeta
      if (i === ownerSlugs.length - 1) {
        // último: podemos mover (el archivo plano ya no se necesita)
        await fs.rename(src, dest);
        moved++;
      } else {
        await fs.copyFile(src, dest);
        copied++;
      }
    }
  }

  for (const { mdPath, after } of plan.values()) {
    await fs.writeFile(mdPath, after);
  }

  // Archivos planos huérfanos (quedaron en public/mapas/ sin subcarpeta).
  const post = await fs.readdir(MAPAS_DIR, { withFileTypes: true });
  const stillFlat = post.filter((e) => e.isFile()).map((e) => e.name);

  log(`\n=== Resultado ===`);
  log(`content.md reescritos: ${plan.size}`);
  log(`archivos movidos: ${moved}`);
  log(`archivos copiados (shared): ${copied}`);
  if (stillFlat.length) {
    log(`\nArchivos planos restantes en public/mapas/ (${stillFlat.length}):`);
    for (const f of stillFlat) log(`  ${f}`);
    log(`\nSi son huérfanos, borralos a mano. Si los querés asociar a algún evento,\nreferencialos desde ese content.md y re-corré este script.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
