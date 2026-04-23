// Migración one-shot: mover imágenes de "Mapas eventos TERCO (F)/" a public/mapas/,
// reescribir todas las líneas MAPA_DE de content.md con las nuevas URLs relativas
// (/mapas/<archivo>), y borrar MAPA_DE de eventos sin imagen nueva.
//
// Uso: node scripts/migrate-mapas.mjs [--dry]

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'Mapas eventos TERCO (F)');
const DST_DIR = path.join(ROOT, 'public', 'mapas');
const EVENTS_DIR = path.join(ROOT, 'data', 'eventos');

const DRY = process.argv.includes('--dry');

// Mapeo explícito: slug → [ { src, label } ]
// src = nombre original del archivo en la carpeta de entrada
const MAPPING = {
  'acdc': [{ src: 'Ac-dc Mapa.png', label: 'AC/DC' }],
  'air-supplay-135': [{ src: 'Air Supply Mapa.png', label: 'Air Supply' }],
  'airbag': [{ src: 'Airbag Velez Mapa.png', label: 'Airbag Vélez' }],
  'alejandro-sanz-rosario': [{ src: 'Alejandro SANZ.png', label: 'Alejandro Sanz' }],
  'alejo-igoa': [{ src: 'Alejo Igoa Mapa.png', label: 'Alejo Igoa' }],
  'arjona-en-movistar-arena-2026': [{ src: 'Arjona Mapa.png', label: 'Ricardo Arjona' }],
  'babasonicos': [{ src: 'Babasonicos Union Mapa.png', label: 'Babasónicos Unión' }],
  'big-time-rush-en-movistar': [{ src: 'Big Time Rush Mapa.png', label: 'Big Time Rush' }],
  'bryan-adams-153': [{ src: 'Bryan Adams Mapa.png', label: 'Bryan Adams' }],
  'bts-en-river': [{ src: 'BTS Mapa.png', label: 'BTS' }],
  'cazzu-en-movistar': [
    { src: 'Cazzu Movistar Mapa.jpeg', label: 'Cazzu Movistar' },
    { src: 'Cazzu.png', label: 'Cazzu (adicional)' },
  ],
  'chayanne-2026': [
    { src: 'Chayanne Movistar.png', label: 'Chayanne Movistar' },
    { src: 'Chayanne Cordoba.jpeg', label: 'Chayanne Córdoba' },
  ],
  'disney-on-ice': [{ src: 'Disney on Ice Mapa.png', label: 'Disney on Ice' }],
  'dream-theater-244': [{ src: 'Dream Theater Mapa.png', label: 'Dream Theater' }],
  'el-oficial-gordillo': [{ src: 'Gordillo Mapa.png', label: 'Oficial Gordillo' }],
  'el-plan-de-la-mariposa': [{ src: 'El Plan Mapa.png', label: 'El Plan de la Mariposa' }],
  'eros-ramazzotti-2811': [{ src: 'Eros Ramazzotti Mapa.png', label: 'Eros Ramazzotti' }],
  'franco-colapinto': [{ src: 'Colapinto Mapa.png', label: 'Franco Colapinto' }],
  'fundamentalistas': [{ src: 'Fundamentalistas.png', label: 'Fundamentalistas' }],
  'helloween-139': [{ src: 'Helloween Mapa.png', label: 'Helloween' }],
  'il-volo': [{ src: 'Il Volo Movistar.png', label: 'Il Volo Movistar' }],
  'il-volo-2026': [{ src: 'Il Volo Cordoba.png', label: 'Il Volo Córdoba' }],
  'iron-maiden-2010': [{ src: 'Iron Maiden Mapa Huracan.jpeg', label: 'Iron Maiden Huracán' }],
  'k4os': [{ src: 'K4os Mapa Rosario.png', label: 'K4OS Rosario' }],
  'korn': [{ src: 'Korn.jpeg', label: 'Korn' }],
  'lali-river-rumor': [{ src: 'Lali Mapa.png', label: 'Lali' }],
  'lollapalooza-2026': [
    { src: 'Lolla - Viernes.png', label: 'Lollapalooza Viernes' },
    { src: 'Lolla - Sabado.png', label: 'Lollapalooza Sábado' },
    { src: 'Lolla - Domingo.png', label: 'Lollapalooza Domingo' },
  ],
  'love-the-90s': [{ src: 'Love The 90s Mapa.png', label: 'Love The 90s' }],
  'luciano-pereyra-244': [{ src: 'Luciano Pereyra Mapa.png', label: 'Luciano Pereyra' }],
  'megadeth-304': [{ src: 'Megadeth.jpeg', label: 'Megadeth' }],
  'midachi-en-gran-rex': [{ src: 'Midachi Mapa.png', label: 'Midachi Gran Rex' }],
  'morat': [{ src: 'Morat Mapa.png', label: 'Morat' }],
  'myke-towers': [{ src: 'Myke Towers Mapa.png', label: 'Myke Towers' }],
  'pablo-alboran-53': [{ src: 'Pablo Alboran Mapa.png', label: 'Pablo Alborán' }],
  'pastillas-del-abuelo': [{ src: 'Las Pastillas Mapa.png', label: 'Las Pastillas del Abuelo' }],
  'pimpinelas': [{ src: 'Pimpinela Mapa.png', label: 'Pimpinela' }],
  'premier-padel': [{ src: 'Premier Padel Mapa.png', label: 'Premier Padel' }],
  'ricardo-montaner-282': [{ src: 'Ricardo Montaner Mapa.png', label: 'Ricardo Montaner' }],
  'ricky-martin': [{ src: 'Ricky Martin Mapa Rosario.png', label: 'Ricky Martin Rosario' }],
  'robbie-williams': [{ src: 'Robbie Williams Mapa.png', label: 'Robbie Williams' }],
  'robert-plant-rosario': [{ src: 'Robert Plant Mapa Rosario.png', label: 'Robert Plant Rosario' }],
  'romeo-santos': [{ src: 'Romeo Santos Mapa.png', label: 'Romeo Santos' }],
  'rosalia-en-movistar': [{ src: 'Rosalia Mapa.png', label: 'Rosalía' }],
  'roxette-164': [{ src: 'Roxette Mapa.png', label: 'Roxette' }],
  'seleccion-argentina-partidos': [{ src: 'Argentina Mapa.png', label: 'Selección Argentina' }],
  'soda-en-movistar': [{ src: 'Soda Stereo Mapa.png', label: 'Soda Stereo' }],
  'tan-bionica': [
    { src: 'TAN BIONICA.jpeg', label: 'Tan Bionica' },
    { src: 'Tan Bionica Estadio UNO.png', label: 'Tan Bionica Estadio UNO' },
  ],
  'tini-futttura': [
    { src: 'TINI MAPA.jpeg', label: 'Tini' },
    { src: 'Tini Rosario Mapa.png', label: 'Tini Rosario' },
  ],
  'zayn': [{ src: 'Zayn Mapa.png', label: 'Zayn' }],
};

// Nombre "original con -": reemplaza espacios por un único dash, preserva mayúsculas y
// extensión tal cual.
function renameForUrl(filename) {
  return filename.replace(/\s+/g, '-').replace(/-+/g, '-');
}

// Quita líneas "- MAPA_DE ..." (o sin el "-") y las líneas en blanco colgantes.
// Retorna { stripped, insertionPoint } donde insertionPoint es la posición (índice de
// línea) donde se debe insertar el bloque nuevo.
function stripMapaLines(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const isMapa = (l) => /^\s*-?\s*MAPA_DE\s+/.test(l);
  let firstIdx = -1;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMapa(lines[i])) {
      if (firstIdx === -1) firstIdx = out.length;
      continue;
    }
    out.push(lines[i]);
  }
  // Si había mapa: colapsar líneas en blanco consecutivas alrededor del insertionPoint
  return { lines: out, insertionPoint: firstIdx };
}

function buildMapaBlock(entries) {
  return entries.map((e) => `- MAPA_DE "${e.label}" → /mapas/${renameForUrl(e.src)}`);
}

async function main() {
  const errors = [];
  const report = {
    imagesCopied: 0,
    imagesSkipped: 0,
    eventsWithNewMaps: 0,
    eventsStripped: 0,
    lostMapa: [],
  };

  // 1) Crear destino
  if (!DRY) await fs.mkdir(DST_DIR, { recursive: true });

  // 2) Copiar todas las imágenes del mapping
  const allSrcs = new Set();
  for (const entries of Object.values(MAPPING)) for (const e of entries) allSrcs.add(e.src);

  for (const src of allSrcs) {
    const from = path.join(SRC_DIR, src);
    const to = path.join(DST_DIR, renameForUrl(src));
    try {
      await fs.access(from);
    } catch {
      errors.push(`NO ENCONTRADA: ${src}`);
      continue;
    }
    if (DRY) {
      console.log(`cp "${src}" → public/mapas/${renameForUrl(src)}`);
      report.imagesCopied++;
    } else {
      await fs.copyFile(from, to);
      report.imagesCopied++;
    }
  }

  // 3) Para cada evento: strip MAPA_DE existentes + insertar nuevos si hay imagen
  const eventSlugs = (await fs.readdir(EVENTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const slug of eventSlugs) {
    const cp = path.join(EVENTS_DIR, slug, 'content.md');
    let content;
    try {
      content = await fs.readFile(cp, 'utf8');
    } catch {
      continue;
    }
    const hadMapa = /MAPA_DE\s+/.test(content);
    const { lines, insertionPoint } = stripMapaLines(content);
    const mapping = MAPPING[slug];

    let newLines = lines;

    if (mapping && mapping.length) {
      const block = buildMapaBlock(mapping);
      if (insertionPoint === -1) {
        // No había MAPA_DE pero sí hay imagen → append al final con header implícito
        newLines = [...lines];
        if (newLines[newLines.length - 1] !== '') newLines.push('');
        newLines.push(...block);
        newLines.push('');
      } else {
        newLines = [
          ...lines.slice(0, insertionPoint),
          ...block,
          ...lines.slice(insertionPoint),
        ];
      }
      report.eventsWithNewMaps++;
    } else if (hadMapa) {
      report.eventsStripped++;
      report.lostMapa.push(slug);
    }

    // Colapsar 3+ líneas en blanco → 2
    const final = newLines.join('\n').replace(/\n{3,}/g, '\n\n');

    if (!DRY) {
      await fs.writeFile(cp, final);
    } else if (mapping || hadMapa) {
      console.log(`-- ${slug}: ${mapping ? `${mapping.length} mapa(s) nuevos` : 'strip'}`);
    }
  }

  // 4) Reporte
  console.log('\n===== REPORTE =====');
  console.log(`imágenes copiadas: ${report.imagesCopied}`);
  console.log(`eventos con nuevo mapa: ${report.eventsWithNewMaps}`);
  console.log(`eventos a los que se les borró MAPA_DE: ${report.eventsStripped}`);
  if (report.lostMapa.length) {
    console.log('\nSin reemplazo (MAPA_DE eliminados):');
    for (const s of report.lostMapa) console.log('  -', s);
  }
  if (errors.length) {
    console.log('\nERRORES:');
    for (const e of errors) console.log('  -', e);
  }
  if (DRY) console.log('\n(dry-run — no se escribió nada)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
