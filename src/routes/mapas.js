// Sirve imágenes de mapas: primero busca en Postgres (event_media), si no
// existe hace fallback al filesystem (public/mapas/<slug>/<filename>) y si
// tampoco está, devuelve 404 limpio.
//
// El handler se monta antes del auth middleware para que el agente IA y los
// usuarios públicos puedan ver las imágenes sin cookie.

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSql } from '../services/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FS_FALLBACK_DIR = path.resolve(__dirname, '../../public/mapas');

const router = express.Router();

const SAFE = /^[\w.-]+$/;
function bad(s) {
  return !s || !SAFE.test(s) || s.startsWith('.') || s.includes('..');
}

router.get('/:slug/:filename', async (req, res) => {
  const { slug, filename } = req.params;
  if (bad(slug) || bad(filename)) {
    return res.status(400).send('Invalid path');
  }

  // 1) Intentar DB primero.
  try {
    const sql = getSql();
    const [row] = await sql`
      SELECT content_type, data FROM event_media
      WHERE slug = ${slug} AND filename = ${filename}
    `;
    if (row) {
      res.setHeader('Content-Type', row.content_type);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(row.data);
    }
  } catch (err) {
    console.warn('[mapas] DB query falló:', err.message);
  }

  // 2) Fallback al filesystem (imágenes que sobrevivieron de antes de la migración).
  try {
    const fsPath = path.join(FS_FALLBACK_DIR, slug, filename);
    const data = await fs.readFile(fsPath);
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === '.png' ? 'image/png' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(data);
  } catch {}

  // 3) Nada en DB ni FS — 404 limpio (NO redirect a /login).
  res.status(404).send('Not found');
});

export default router;
