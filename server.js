import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import eventsRouter from './src/routes/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
