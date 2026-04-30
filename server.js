import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import eventsRouter from './src/routes/events.js';
import thumbsRouter from './src/routes/thumbs.js';
import usageRouter from './src/routes/usage.js';
import storiesRouter, { publicGetStoryText, publicPutStoryText, publicGetStoryMedia } from './src/routes/stories.js';
import mapasRouter from './src/routes/mapas.js';
import { pullFromVectorStore } from './src/services/master.js';
import { runMigrations, getSql } from './src/services/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-bootstrap: si la tabla `events` está vacía al arrancar, bajar todo del
// vector store. Esto resuelve el caso de DB nueva — la UI arranca poblada sin
// intervención humana.
async function bootstrapFromVectorStore(app) {
  app.locals.bootstrap = { active: false, current: 0, total: 0, error: null };
  if (!process.env.DATABASE_URL) {
    console.log('[bootstrap] DATABASE_URL no configurada, skip');
    return;
  }
  try {
    const sql = getSql();
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM events`;
    if (count > 0) {
      console.log(`[bootstrap] DB ya tiene ${count} eventos, skip pull`);
      return;
    }
    if (!process.env.OPENAI_VECTOR_STORE_ID || !process.env.OPENAI_API_KEY) {
      console.log('[bootstrap] OPENAI_* no configurado, skip pull');
      app.locals.bootstrap.error = 'OPENAI_API_KEY u OPENAI_VECTOR_STORE_ID no configurados';
      return;
    }
    console.log('[bootstrap] data/eventos vacío — pulling del vector store...');
    const t0 = Date.now();
    app.locals.bootstrap.active = true;
    const result = await pullFromVectorStore((ev) => {
      if (ev.type === 'start') {
        app.locals.bootstrap.total = ev.total;
        console.log(`[bootstrap] ${ev.total} archivos a descargar`);
      }
      if (ev.type === 'progress') {
        app.locals.bootstrap.current = ev.current;
      }
      if (ev.type === 'done') console.log(`[bootstrap] listo en ${Date.now() - t0}ms: ${ev.result.events} eventos`);
    });
    if (result?.errors?.length) {
      console.warn(`[bootstrap] ${result.errors.length} archivos fallaron`);
    }
  } catch (err) {
    console.error('[bootstrap] falló:', err.message);
    app.locals.bootstrap.error = err.message;
    // No crasheamos: el server igual arranca, la UI va a estar vacía hasta pull manual.
  } finally {
    app.locals.bootstrap.active = false;
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
//
// /mapas es ahora un router custom que sirve desde Postgres (BYTEA) con
// fallback al filesystem para imágenes legacy. Reemplazó al express.static.
app.use('/mapas', mapasRouter);
app.use('/thumb', thumbsRouter);

// Endpoints públicos de stories (antes del auth middleware).
// - GET: lo usa el agente IA desde Chatrace para consultar el texto asignado.
// - PUT: con header `X-API-Key` permite escritura externa (n8n, webhooks, etc.).
//   Sin header pasa al middleware de auth y cae al router admin (UI con cookie).
app.get('/api/stories/:id/text', publicGetStoryText);
app.put('/api/stories/:id/text', publicPutStoryText);
app.get('/api/stories/:id/media', publicGetStoryMedia);

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
app.use('/api/usage', usageRouter);
app.use('/api/stories', storiesRouter);

app.get('/editor/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.get('/preview', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.get('/usage', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'usage.html'));
});

app.get('/lista', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lista.html'));
});

app.get('/stories', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stories.html'));
});

if (!authEnabled) {
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
}

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  // Aplicar migraciones SQL si DATABASE_URL está configurada.
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
    } catch (err) {
      console.error('[db] migraciones fallaron:', err.message);
    }
  } else {
    console.warn('[db] DATABASE_URL no configurada — la app no va a poder leer/escribir eventos');
  }
  await bootstrapFromVectorStore(app);
});
