// Exporta los eventos a ./export-chatrace/ con la estructura:
//   export-chatrace/
//     _reglas-comunes/prompt.md  (agente de reglas — con prefijo _ para que aparezca primero)
//     _agente-reservas/prompt.md (si tiene contenido)
//     <slug>/
//       prompt.md       (solo datos del evento — limpio, sin MAPA_DE, sin reglas)
//       imagenN.ext     (todas las imágenes del evento)
//     _README.md
//
// Uso:
//   node scripts/export-chatrace.mjs
//   node scripts/export-chatrace.mjs --out=/ruta/destino    (opcional)
//   node scripts/export-chatrace.mjs --with-rules           (mete reglas en cada prompt — modo viejo)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'eventos');
const MAPAS_DIR = path.join(ROOT, 'public', 'mapas');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

// Sufijo .nosync = iCloud Drive excluye la carpeta de sync (no crea ghost <name> 2/, 3/).
const OUT_DIR = path.resolve(args.out || path.join(ROOT, 'export-chatrace.nosync'));
// Por default: reglas como agente aparte (no se inyectan en cada evento).
// Con --with-rules: reglas se concatenan en cada prompt.md (modo viejo).
const INCLUDE_RULES = !!args['with-rules'];

// Slugs que NO son eventos comerciales — se exportan como agentes especiales aparte.
const SPECIAL = new Set(['reglas-comunes', 'agente-reservas']);

// Renombres manuales para resolver colisiones cuando se quita el sufijo numérico.
// Cuando dos eventos comparten el mismo "slug limpio", hay que disambiguarlos.
const SLUG_OVERRIDES = {
  'il-volo': 'il-volo-bsas',
  'il-volo-2026': 'il-volo-cordoba',
};

// Limpia un slug quitando el sufijo numérico (típicamente fechas tipo `-153` = 15/3, `-2811` = 28/11,
// o años `-2026`). Si genera colisión con otro slug del set, devuelve el slug original sin tocar.
function cleanSlug(slug, allSlugs) {
  if (SLUG_OVERRIDES[slug]) return SLUG_OVERRIDES[slug];
  const clean = slug.replace(/-\d+$/, '');
  if (clean === slug) return slug; // no tenía sufijo numérico
  // Si el limpio coincide con otro slug existente, devolver original.
  if (allSlugs.has(clean) && clean !== slug) return slug;
  return clean;
}

// Limpieza de bloques de mapa que ya no aplican (las imágenes van como adjuntos en Chatrace).
// Tolera variantes:
//   **Mapa / distribución de sectores (imagen):**     (singular, sin acento en la 'a')
//   **Mapas / distribución de sectores (imágenes):**  (plural, CON acento en la 'á')
const MAPA_HEADER = /\*\*Mapas? \/ distribución de sectores \(im[aá]gen(?:es)?\):\*\*/;

function stripMapaBloque(md) {
  let out = md;
  // Header + 1 o más MAPA_DE seguidos.
  out = out.replace(
    new RegExp(MAPA_HEADER.source + '\\n+(?:- MAPA_DE [^\\n]*\\n+)+', 'g'),
    ''
  );
  // Header solitario (eventos sin imagen, o donde el detalle se omitió).
  out = out.replace(new RegExp(MAPA_HEADER.source + '\\n+', 'g'), '');
  // MAPA_DE suelto (defensivo).
  out = out.replace(/^- MAPA_DE [^\n]*\n/gm, '');
  // Colapsar saltos.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readMaybe(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function listImages(slug) {
  const dir = path.join(MAPAS_DIR, slug);
  if (!(await pathExists(dir))) return [];
  const files = await fs.readdir(dir);
  // Ignorar archivos ocultos / basura iCloud.
  return files
    .filter((f) => !f.startsWith('.') && !/ \d+\./.test(f))
    .sort((a, b) => {
      // imagen1, imagen2, … primero, luego el resto.
      const na = parseInt((a.match(/^imagen(\d+)/i) || [])[1] || '999', 10);
      const nb = parseInt((b.match(/^imagen(\d+)/i) || [])[1] || '999', 10);
      return na - nb || a.localeCompare(b);
    });
}

async function main() {
  console.log(`Exportando a: ${OUT_DIR}`);
  console.log(`Reglas comunes: ${INCLUDE_RULES ? 'incluidas' : 'omitidas'}\n`);

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 1. Cargar reglas comunes (si aplica).
  const rules = INCLUDE_RULES
    ? await readMaybe(path.join(DATA_DIR, 'reglas-comunes', 'content.md'))
    : null;

  if (INCLUDE_RULES && !rules) {
    console.warn('⚠  No se encontró reglas-comunes/content.md — se exporta sin reglas.');
  }

  // 2. Listar eventos.
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const eventSlugs = entries
    .filter((e) => e.isDirectory() && !SPECIAL.has(e.name))
    .map((e) => e.name)
    .sort();

  const report = []; // {slug, title, imageCount, promptBytes, kind}

  // 2a. Agentes especiales (reglas, reservas) — primero.
  for (const slug of [...SPECIAL]) {
    const content = await readMaybe(path.join(DATA_DIR, slug, 'content.md'));
    if (!content || content.trim() === '---' || content.trim().length < 5) {
      console.log(`  ⚠  ${slug}: vacío, salto`);
      continue;
    }
    let title = slug;
    try {
      const meta = JSON.parse((await readMaybe(path.join(DATA_DIR, slug, 'meta.json'))) || '{}');
      title = meta.title || slug;
    } catch { /* ignore */ }

    const cleaned = stripMapaBloque(content).trim();
    const prompt = `# ${title}\n\n${cleaned}\n`;
    const outDir = path.join(OUT_DIR, '_' + slug); // prefijo _ para que aparezca primero
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'prompt.md'), prompt);
    report.push({ slug, title, imageCount: 0, promptBytes: prompt.length, kind: 'agente' });
    console.log(`  ✓ _${slug} [agente] (prompt ${(prompt.length / 1024).toFixed(1)} KB)`);
  }

  // 2b. Eventos comerciales.
  const allSlugsSet = new Set(eventSlugs);
  for (const slug of eventSlugs) {
    const contentPath = path.join(DATA_DIR, slug, 'content.md');
    const metaPath = path.join(DATA_DIR, slug, 'meta.json');
    const content = await readMaybe(contentPath);
    if (!content) {
      console.log(`  ⚠  ${slug}: sin content.md, salto`);
      continue;
    }

    let title = slug;
    try {
      const meta = JSON.parse((await readMaybe(metaPath)) || '{}');
      title = meta.title || slug;
    } catch { /* ignore */ }

    // Limpiar el sufijo numérico del slug para la carpeta de salida (las imágenes y los datos
    // del origen no se tocan — esto solo afecta la carpeta del export).
    const exportSlug = cleanSlug(slug, allSlugsSet);
    const outDir = path.join(OUT_DIR, exportSlug);
    await fs.mkdir(outDir, { recursive: true });

    // 3. Componer prompt.md.
    //    - default: solo evento (limpio, sin MAPA_DE, sin reglas)
    //    - --with-rules: reglas + evento (modo viejo)
    const cleanedContent = stripMapaBloque(content).trim();
    const parts = [];
    if (INCLUDE_RULES && rules) {
      parts.push('# Reglas comunes (Terco Tour)\n');
      parts.push(rules.trim());
      parts.push('\n---\n');
    }
    parts.push(`# ${title}\n`);
    parts.push(cleanedContent);
    const prompt = parts.join('\n') + '\n';
    await fs.writeFile(path.join(outDir, 'prompt.md'), prompt);

    // 4. Copiar imágenes.
    const images = await listImages(slug);
    for (const img of images) {
      const src = path.join(MAPAS_DIR, slug, img);
      const dst = path.join(outDir, img);
      await fs.copyFile(src, dst);
    }

    report.push({
      slug: exportSlug,
      origSlug: slug,
      title,
      imageCount: images.length,
      promptBytes: prompt.length,
      kind: 'evento',
    });

    const renameTag = exportSlug !== slug ? ` (← ${slug})` : '';
    console.log(`  ✓ ${exportSlug}${renameTag} (${images.length} img, prompt ${(prompt.length / 1024).toFixed(1)} KB)`);
  }

  // 5. README.
  const eventos = report.filter((r) => r.kind === 'evento');
  const agentes = report.filter((r) => r.kind === 'agente');
  const withImages = eventos.filter((r) => r.imageCount > 0).length;
  const withoutImages = eventos.length - withImages;
  const totalBytes = report.reduce((s, r) => s + r.promptBytes, 0);

  const lines = [
    `# Export Chatrace`,
    '',
    `Generado: ${new Date().toISOString()}`,
    '',
    `- Agentes especiales: **${agentes.length}** (reglas, reservas)`,
    `- Eventos: **${eventos.length}** (${withImages} con imagen, ${withoutImages} sin)`,
    `- Tamaño total prompts: **${(totalBytes / 1024).toFixed(1)} KB**`,
    `- Tamaño promedio prompt evento: **${eventos.length ? (eventos.reduce((s, r) => s + r.promptBytes, 0) / eventos.length / 1024).toFixed(1) : 0} KB**`,
    `- Reglas en cada prompt: ${INCLUDE_RULES ? '**sí** (modo --with-rules)' : '**no** — están como agente aparte en `_reglas-comunes/`'}`,
    '',
    '## Estructura',
    '',
    '```',
    'export-chatrace/',
    ...agentes.map((r) => `├── _${r.slug}/\n│   └── prompt.md       (agente)`),
    ...eventos.slice(0, 3).map((r) => {
      const imgs = r.imageCount === 0 ? '' : `\n│   ├── imagen1.*`;
      return `├── ${r.slug}/\n│   ├── prompt.md${imgs}`;
    }),
    '...',
    '```',
    '',
    '## Agentes especiales',
    '',
    '| Slug | Título | Prompt (KB) |',
    '|---|---|---|',
    ...agentes.map((r) =>
      `| \`_${r.slug}\` | ${r.title} | ${(r.promptBytes / 1024).toFixed(1)} |`
    ),
    '',
    '## Eventos',
    '',
    '| Slug | Título | Imágenes | Prompt (KB) |',
    '|---|---|---|---|',
    ...eventos.map((r) =>
      `| \`${r.slug}\` | ${r.title} | ${r.imageCount || '—'} | ${(r.promptBytes / 1024).toFixed(1)} |`
    ),
    '',
    '## Eventos sin imagen',
    '',
    ...eventos.filter((r) => !r.imageCount).map((r) => `- ${r.slug} — ${r.title}`),
    '',
  ];

  await fs.writeFile(path.join(OUT_DIR, '_README.md'), lines.join('\n'));

  // 6. Limpiar carpetas vacías y duplicados de iCloud (`name 2`, `name 3`, etc.)
  //    Pueden aparecer si la salida se guarda en una ruta sincronizada por iCloud.
  let ghostsRemoved = 0;
  const allDirs = await fs.readdir(OUT_DIR, { withFileTypes: true });
  for (const d of allDirs) {
    if (!d.isDirectory()) continue;
    const isGhost = / \d+$/.test(d.name);
    const dirPath = path.join(OUT_DIR, d.name);
    let entries;
    try { entries = await fs.readdir(dirPath); } catch { continue; }
    if (isGhost || entries.length === 0) {
      await fs.rm(dirPath, { recursive: true, force: true });
      ghostsRemoved++;
    }
  }

  console.log(`\n=== Resultado ===`);
  console.log(`Agentes:  ${agentes.length} (reglas, reservas)`);
  console.log(`Eventos:  ${eventos.length} (${withImages} con imagen, ${withoutImages} sin)`);
  console.log(`Tamaño total: ${(totalBytes / 1024).toFixed(1)} KB`);
  if (ghostsRemoved) console.log(`Carpetas fantasma de iCloud eliminadas: ${ghostsRemoved}`);
  console.log(`Salida: ${OUT_DIR}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
