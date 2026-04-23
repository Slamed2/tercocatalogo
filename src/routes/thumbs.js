// GET /thumb/<slug>/<filename>?w=400&fmt=webp  (nuevo, con subcarpeta por evento)
// GET /thumb/<filename>?w=400&fmt=webp          (legacy, planos en public/mapas/)
//
// Devuelve una versión redimensionada del original en public/mapas/..., con
// caché en disco (data/_master/thumbs/).
//
// Reglas:
//  - Si no está w, default 400. Si está, clamp 80..1600.
//  - fmt: 'webp' (default) o 'jpeg'.
//  - Caché por {slug}__{basename}_{w}.{fmt} en data/_master/thumbs/.
//  - 404 si el original no existe.

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPAS_DIR = path.join(__dirname, '../../public/mapas');
const THUMBS_DIR = path.join(__dirname, '../../data/_master/thumbs');

const router = express.Router();

const VALID_FMT = new Set(['webp', 'jpeg']);
const SAFE_PART = /^[\w.-]+$/; // letras, números, _ . -

function badPart(s) {
  return !s || !SAFE_PART.test(s) || s.startsWith('.') || s.includes('..');
}

async function serveThumb(req, res, relPath) {
  try {
    let w = parseInt(req.query.w, 10);
    if (!Number.isFinite(w)) w = 400;
    w = Math.max(80, Math.min(1600, w));

    let fmt = String(req.query.fmt || 'webp').toLowerCase();
    if (!VALID_FMT.has(fmt)) fmt = 'webp';

    const srcPath = path.join(MAPAS_DIR, relPath);
    try { await fs.access(srcPath); }
    catch { return res.status(404).end(); }

    const cacheKey = relPath.replace(/\//g, '__').replace(/\.[^.]+$/, '');
    const cacheName = `${cacheKey}_${w}.${fmt}`;
    const cachePath = path.join(THUMBS_DIR, cacheName);

    // Servir de caché si es más nueva que la fuente.
    try {
      const [srcStat, cacheStat] = await Promise.all([
        fs.stat(srcPath),
        fs.stat(cachePath),
      ]);
      if (cacheStat.mtimeMs >= srcStat.mtimeMs) {
        res.setHeader('Content-Type', fmt === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return fsSync.createReadStream(cachePath).pipe(res);
      }
    } catch {
      // cache miss → generar
    }

    await fs.mkdir(THUMBS_DIR, { recursive: true });
    const pipeline = sharp(srcPath).resize({ width: w, withoutEnlargement: true });
    const out = fmt === 'webp'
      ? pipeline.webp({ quality: 78 })
      : pipeline.jpeg({ quality: 80, mozjpeg: true });

    const buf = await out.toBuffer();
    await fs.writeFile(cachePath, buf);

    res.setHeader('Content-Type', fmt === 'webp' ? 'image/webp' : 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(buf);
  } catch (err) {
    console.error('thumb error:', err.message);
    res.status(500).end();
  }
}

// Nuevo: /thumb/<slug>/<filename>
router.get('/:slug/:filename', (req, res) => {
  const { slug, filename } = req.params;
  if (badPart(slug) || badPart(filename)) return res.status(400).end();
  return serveThumb(req, res, `${slug}/${filename}`);
});

// Legacy: /thumb/<filename> (archivos planos en public/mapas/).
router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  if (badPart(filename)) return res.status(400).end();
  return serveThumb(req, res, filename);
});

export default router;
