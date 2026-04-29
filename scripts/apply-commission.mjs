// Aplica un markup (default 50%) a todos los precios en formato $NNN.NNN
// encontrados dentro de data/eventos/*/content.md.
//
// Uso:
//   node scripts/apply-commission.mjs --dry         (solo muestra el diff)
//   node scripts/apply-commission.mjs               (aplica con markup 50%)
//   node scripts/apply-commission.mjs --pct=40      (markup distinto)
//   node scripts/apply-commission.mjs --round=500   (redondea al múltiplo)
//
// Después de aplicar, re-sincroniza el VS (cada evento + lista-eventos).

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'eventos');
const BACKUP_DIR = path.join(ROOT, 'data', '_backups');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const DRY = !!args.dry;
const PCT = Number(args.pct ?? 50);
const ROUND = args.round ? Number(args.round) : 0;
const SYNC_AFTER = !DRY && !args['no-sync'];

if (Number.isNaN(PCT) || PCT < 0) {
  console.error('--pct debe ser un número >= 0');
  process.exit(1);
}

// Captura precios con formato $XXX.XXX, $X.XXX.XXX, etc.
// Permite espacio entre $ y número, separador . o , para miles.
const PRICE_RE = /\$\s*(\d{1,3}(?:[.,]\d{3})+)(?!\d)/g;

function parseAr(numStr) {
  // "280.000" → 280000. "1.250.000" → 1250000. Ignora coma decimal (no aplica acá).
  return parseInt(numStr.replace(/[.,]/g, ''), 10);
}

function formatAr(n) {
  // 420000 → "420.000"
  return n.toLocaleString('es-AR');
}

function applyMarkup(price) {
  let out = Math.round(price * (1 + PCT / 100));
  if (ROUND > 0) out = Math.round(out / ROUND) * ROUND;
  return out;
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, ts);

  console.log(`Markup: +${PCT}%`);
  if (ROUND) console.log(`Redondeo: múltiplos de ${formatAr(ROUND)}`);
  console.log(DRY ? 'Modo: DRY-RUN (no escribe)' : `Modo: APLICAR (backup en ${backupPath})`);
  console.log();

  if (!DRY) {
    await fs.mkdir(backupPath, { recursive: true });
  }

  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  let totalReplacements = 0;
  let totalEventsTouched = 0;
  const examples = [];

  for (const slug of slugs) {
    const file = path.join(DATA_DIR, slug, 'content.md');
    let content;
    try { content = await fs.readFile(file, 'utf8'); } catch { continue; }

    const before = content;
    let count = 0;

    const updated = content.replace(PRICE_RE, (match, num) => {
      const old = parseAr(num);
      const next = applyMarkup(old);
      count++;
      if (examples.length < 8 || (examples.length < 30 && Math.random() < 0.2)) {
        examples.push({ slug, old: `$${formatAr(old)}`, new: `$${formatAr(next)}` });
      }
      return `$${formatAr(next)}`;
    });

    if (count === 0) continue;
    totalEventsTouched++;
    totalReplacements += count;

    if (!DRY) {
      // Backup
      await fs.mkdir(path.join(backupPath, slug), { recursive: true });
      await fs.writeFile(path.join(backupPath, slug, 'content.md'), before);
      // Aplicar
      await fs.writeFile(file, updated);
    }
  }

  console.log('=== Resumen ===');
  console.log(`Eventos afectados: ${totalEventsTouched}`);
  console.log(`Precios reemplazados: ${totalReplacements}`);
  console.log();
  console.log('=== Ejemplos ===');
  for (const ex of examples.slice(0, 12)) {
    console.log(`  ${ex.slug}: ${ex.old} → ${ex.new}`);
  }
  if (examples.length > 12) console.log(`  ... y ${examples.length - 12} más`);

  if (DRY) {
    console.log('\n[dry-run] Para aplicar: node scripts/apply-commission.mjs');
    return;
  }

  console.log(`\n✓ Backup en: ${backupPath}`);

  if (SYNC_AFTER) {
    console.log('\n=== Sincronizando al vector store ===');
    const { syncEventFile, syncListaEventosFile } = await import('../src/services/master.js');

    let synced = 0;
    let failed = 0;
    for (const slug of slugs) {
      try {
        await syncEventFile(slug);
        synced++;
        if (synced % 10 === 0) console.log(`  ${synced}/${slugs.length}...`);
      } catch (err) {
        failed++;
        console.warn(`  ⚠ ${slug}: ${err.message}`);
      }
    }
    console.log(`  Eventos sincronizados: ${synced} (${failed} errores)`);

    try {
      await syncListaEventosFile();
      console.log('  ✓ lista-eventos.md sincronizada');
    } catch (err) {
      console.warn('  ⚠ lista-eventos:', err.message);
    }
  }

  console.log('\nListo.');
}

main().catch((err) => { console.error(err); process.exit(1); });
