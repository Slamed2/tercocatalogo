// GET /thumb/<filename>?w=400&fmt=webp — devuelve una versión redimensionada de
// public/mapas/<filename>, con caché en disco (data/_master/thumbs/).
//
// Reglas:
//  - Si no está w, default 400. Si está, clamp 80..1600.
//  - fmt: 'webp' (default) o 'jpeg'.
//  - Caché por {basename}_{w}.{fmt} en data/_master/thumbs/.
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

router.get('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    // Seguridad: prohibir path traversal.
    if (filename.includes('/') || filename.includes('..') || filename.startsWith('.')) {
      return res.status(400).end();
    }

    let w = parseInt(req.query.w, 10);
    if (!Number.isFinite(w)) w = 400;
    w = Math.max(80, Math.min(1600, w));

    let fmt = String(req.query.fmt || 'webp').toLowerCase();
    if (!VALID_FMT.has(fmt)) fmt = 'webp';

    const srcPath = path.join(MAPAS_DIR, filename);
    try { await fs.access(srcPath); }
    catch { return res.status(404).end(); }

    const base = filename.replace(/\.[^.]+$/, '');
    const cacheName = `${base}_${w}.${fmt}`;
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
});

export default router;
