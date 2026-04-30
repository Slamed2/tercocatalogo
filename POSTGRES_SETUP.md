# Postgres setup (memoria persistente)

A partir de abril 2026 el catálogo de eventos vive en Postgres en lugar del filesystem. Esto resuelve:

- Bug de huérfanos del Vector Store (file_ids que se rebobinaban en cada deploy de easypanel).
- Pérdida de datos si el contenedor se reemplaza sin volumen persistente.
- Atomicidad de updates (no más estados intermedios entre fs y meta.json).

## Arquitectura

```
events table          → catálogo (slug, title, content, openai_file_id, ...)
master_settings table → preamble + file_ids derivados (lista, catálogo)
public/mapas/         → imágenes (siguen en filesystem)
Vector Store OpenAI   → archivos .md por evento + lista-eventos.md
```

## Configuración local

1. Levantar Postgres local:

   ```bash
   docker run --name eventos-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_USER=eventos -e POSTGRES_DB=eventos -p 5432:5432 -d postgres:16
   ```

2. Agregar al `.env`:

   ```
   DATABASE_URL=postgres://eventos:secret@localhost:5432/eventos
   ```

3. Migrar los datos actuales del filesystem a Postgres:

   ```bash
   node --env-file=.env scripts/migrate-fs-to-db.mjs
   ```

   Esto:
   - Crea las tablas (idempotente)
   - Importa todos los eventos de `data/eventos/<slug>/` a la tabla `events`
   - Importa `data/_master/meta.json` a `master_settings`

4. Arrancar el server:

   ```bash
   npm run dev
   ```

   Al arrancar, ejecuta automáticamente las migraciones SQL pendientes (si las hubiera).

## Configuración en easypanel

1. **Crear servicio Postgres**: en el panel, agregá un servicio Postgres (managed o self-hosted con plantilla).

2. **Conectar al servicio de eventos**: en las variables de entorno del servicio web, agregar:

   ```
   DATABASE_URL=postgres://USER:PASS@HOST:5432/DBNAME
   DATABASE_SSL=true
   ```

   Easypanel suele exponer la URL interna entre servicios — usá esa, no la pública.

3. **Migrar datos a producción** (una sola vez):

   - Opción A — desde el contenedor: `docker exec -it <container> node --env-file=.env scripts/migrate-fs-to-db.mjs`
   - Opción B — vía bootstrap: si la tabla `events` está vacía al arrancar, el server hace pull automático del Vector Store. Es la opción más limpia para una DB nueva en producción.

4. **Verificar**: el endpoint `/healthz` devuelve `200`. La UI carga eventos.

## Rollback

Si algo sale mal, podés volver al filesystem:

1. Comentar `DATABASE_URL` en el `.env`
2. Asegurarte que `data/eventos/` y `data/_master/meta.json` siguen existiendo
3. Revertir el commit que migró a DB (`git revert <hash>`)

Pero ojo: cualquier cambio hecho mientras la DB estaba activa NO está en el filesystem.

## Schema

Ver `migrations/001_init.sql`.

```sql
events:
  slug TEXT PRIMARY KEY
  title TEXT NOT NULL
  content TEXT NOT NULL DEFAULT ''
  is_rules BOOLEAN
  is_index BOOLEAN
  openai_file_id TEXT
  display_order INTEGER
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ

master_settings:
  id INTEGER PRIMARY KEY (always = 1)
  preamble TEXT
  catalog_file_id TEXT
  lista_file_id TEXT
  updated_at TIMESTAMPTZ
```
