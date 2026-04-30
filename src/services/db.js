// Cliente Postgres compartido. Lazy: la conexión se abre en el primer uso.
//
// Configuración: DATABASE_URL (formato `postgres://user:pass@host:port/db`).
// Si no está seteada, todas las funciones que usan la DB tiran un error
// explícito al usarse — el resto del sistema (rutas que no tocan eventos)
// puede seguir funcionando.

import postgres from 'postgres';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let _sql = null;

export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL no configurada. Agregá la conexión a Postgres en el .env.');
  }
  _sql = postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Easypanel/Supabase suelen estar detrás de SSL — relajamos verify si hace falta.
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  return _sql;
}

export async function closeSql() {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

// Aplica todas las migraciones SQL que están en /migrations/, en orden alfabético.
// Las migraciones DEBEN ser idempotentes (CREATE TABLE IF NOT EXISTS, etc.).
// Llamado desde server.js al boot si DATABASE_URL está seteada.
export async function runMigrations() {
  const sql = getSql();
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const content = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await sql.unsafe(content);
    console.log(`[db] migration aplicada: ${file}`);
  }
}

// Helper de health check.
export async function ping() {
  const sql = getSql();
  const rows = await sql`SELECT 1 AS ok`;
  return rows[0]?.ok === 1;
}
