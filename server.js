import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import eventsRouter from './src/routes/events.js';
import thumbsRouter from './src/routes/thumbs.js';
import { pullFromVectorStore } from './src/services/master.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-bootstrap: si data/eventos está vacío al arrancar, bajar todo del vector store.
// Esto resuelve el caso de container nuevo (easypanel tras redeploy sin volumen
// persistente) — la UI arranca poblada sin intervención humana.
async function bootstrapFromVectorStore() {
  const EVENTS_DIR = path.join(__dirname, 'data', 'eventos');
  try {
    await fs.mkdir(EVENTS_DIR, { recursive: true });
    const entries = await fs.readdir(EVENTS_DIR, { withFileTypes: true });
    const nonEmpty = entries.some((e) => e.isDirectory());
    if (nonEmpty) {
      console.log('[bootstrap] data/eventos ya tiene contenido, skip pull');
      return;
    }
    if (!process.env.OPENAI_VECTOR_STORE_ID || !process.env.OPENAI_API_KEY) {
      console.log('[bootstrap] OPENAI_* no configurado, skip pull');
      return;
    }
    console.log('[bootstrap] data/eventos vacío — pulling del vector store...');
    const t0 = Date.now();
    const result = await pullFromVectorStore((ev) => {
      if (ev.type === 'start') console.log(`[bootstrap] ${ev.total} archivos a descargar`);
      if (ev.type === 'done') console.log(`[bootstrap] listo en ${Date.now() - t0}ms: ${ev.result.events} eventos`);
    });
    if (result?.errors?.length) {
      console.warn(`[bootstrap] ${result.errors.length} archivos fallaron`);
    }
  } catch (err) {
    console.error('[bootstrap] falló:', err.message);
    // No crasheamos: el server igual arranca, la UI va a estar vacía hasta pull manual.
  }
}
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const authEnabled = !!(process.env.AUTH_USER && process.env.AUTH_PASS);
const SECRET =
  process.env.SESSION_SECRET ||
  `${process.env.AUTH_USER || ''}:${process.env.AUTH_PASS || ''}:eventos-editor`;

function signToken(user) {
  const data = `${user}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return `${Buffer.from(data).toString('base64url')}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [dataB64, sig] = token.split('.');
  if (!dataB64 || !sig) return null;
  let data;
  try {
    data = Buffer.from(dataB64, 'base64url').toString();
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return data.split('.')[0];
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

// Rutas públicas (antes del auth middleware): mapas e imágenes servidas al
// agente/usuarios finales de OpenAI no tienen cookie de sesión.
app.use('/mapas', express.static(path.join(__dirname, 'public', 'mapas'), {
  maxAge: '7d',
  immutable: true,
}));
app.use('/thumb', thumbsRouter);

if (authEnabled) {
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.post('/login', (req, res) => {
    const { user, pass } = req.body || {};
    if (user === process.env.AUTH_USER && pass === process.env.AUTH_PASS) {
      const token = signToken(user);
      res.setHeader(
        'Set-Cookie',
        `auth=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`
      );
      return res.json({ ok: true });
    }
    res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  });

  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    if (verifyToken(cookies.auth)) return next();
    if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
    res.status(401).json({ error: 'unauthorized' });
  });
}

app.use('/data/eventos', express.static(path.join(__dirname, 'data/eventos')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/events', eventsRouter);

app.get('/editor/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.get('/preview', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

if (!authEnabled) {
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
}

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  await bootstrapFromVectorStore();
});
