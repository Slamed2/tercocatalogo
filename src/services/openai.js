import OpenAI from 'openai';
import fs from 'fs';
import { toFile } from 'openai/uploads';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;

export async function syncFileToVectorStore({ filePath, filename, previousFileId }) {
  if (!VECTOR_STORE_ID) throw new Error('OPENAI_VECTOR_STORE_ID no configurado');

  const uploaded = await client.files.create({
    file: await toFile(fs.createReadStream(filePath), filename || 'content.md'),
    purpose: 'assistants',
  });

  await client.vectorStores.files.create(VECTOR_STORE_ID, { file_id: uploaded.id });

  if (previousFileId) {
    try {
      await client.vectorStores.files.del(VECTOR_STORE_ID, previousFileId);
    } catch (err) {
      console.warn('No se pudo quitar del vector store:', previousFileId, err.message);
    }
    try {
      await client.files.del(previousFileId);
    } catch (err) {
      console.warn('No se pudo eliminar el file anterior:', previousFileId, err.message);
    }
  }

  return uploaded.id;
}

export async function deleteFromVectorStore(fileId) {
  if (!fileId || !VECTOR_STORE_ID) return;
  try {
    await client.vectorStores.files.del(VECTOR_STORE_ID, fileId);
  } catch (err) {
    console.warn('No se pudo quitar del vector store:', err.message);
  }
  try {
    await client.files.del(fileId);
  } catch (err) {
    console.warn('No se pudo eliminar el file:', err.message);
  }
}

// Busca y borra del VS + storage cualquier archivo con ese filename, EXCEPTO el
// que se acaba de subir (`exceptId`). Útil para archivos "singleton" como
// `lista-eventos.md` o `terco-tour-catalogo.md` donde el meta.json puede estar
// desactualizado entre deploys (ver bug de huérfanos en abril 2026).
//
// IMPORTANTE: no usar para archivos por evento — ahí el `previousFileId` del
// meta es suficiente y este sweep haría 1 retrieve por archivo del VS (lento).
export async function dedupeByFilename(filename, exceptId) {
  if (!VECTOR_STORE_ID || !filename) return [];
  const removed = [];
  let after;
  while (true) {
    const page = await client.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100, after });
    for (const vsf of page.data) {
      if (vsf.id === exceptId) continue;
      try {
        const f = await client.files.retrieve(vsf.id);
        if (f.filename === filename) {
          try { await client.vectorStores.files.del(VECTOR_STORE_ID, vsf.id); } catch {}
          try { await client.files.del(vsf.id); } catch {}
          removed.push(vsf.id);
        }
      } catch {}
    }
    if (!page.has_more) break;
    after = page.data[page.data.length - 1]?.id;
    if (!after) break;
  }
  return removed;
}

export async function listVectorStoreFiles() {
  if (!VECTOR_STORE_ID) throw new Error('OPENAI_VECTOR_STORE_ID no configurado');
  const result = [];
  let after;
  while (true) {
    const page = await client.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100, after });
    for (const vsf of page.data) {
      let filename = vsf.id;
      let purpose = null;
      try {
        const f = await client.files.retrieve(vsf.id);
        filename = f.filename || vsf.id;
        purpose = f.purpose || null;
      } catch {}
      result.push({
        id: vsf.id,
        filename,
        purpose,
        created_at: vsf.created_at,
        status: vsf.status,
      });
    }
    if (!page.has_more) break;
    after = page.data[page.data.length - 1]?.id;
    if (!after) break;
  }
  return result;
}

export async function downloadFileContent(fileId) {
  // Intento 1: download directo vía /files/:id/content (requiere purpose downloadable).
  try {
    const response = await client.files.content(fileId);
    if (typeof response?.text === 'function') {
      const txt = await response.text();
      if (txt) return txt;
    }
    if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of response.body) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    if (response?.arrayBuffer) {
      const buf = await response.arrayBuffer();
      return Buffer.from(buf).toString('utf8');
    }
  } catch (err) {
    // Para files con purpose=assistants OpenAI no permite download — caemos al VS content API
    if (err?.status !== 400) throw err;
  }

  // Intento 2: traer el texto parseado desde el vector store (bypasea purpose).
  if (!VECTOR_STORE_ID) throw new Error('OPENAI_VECTOR_STORE_ID no configurado');
  const parts = [];
  for await (const item of client.vectorStores.files.content(VECTOR_STORE_ID, fileId)) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  if (!parts.length) throw new Error('No se pudo obtener contenido del vector store');
  return parts.join('\n');
}

export async function retrieveFileMeta(fileId) {
  return await client.files.retrieve(fileId);
}

// Garantiza que el vector store solo contenga los ids del set keepIds. Elimina todo lo demás.
export async function cleanupOrphans(keepIds) {
  if (!VECTOR_STORE_ID) return { removed: 0 };
  const keep = keepIds instanceof Set ? keepIds : new Set([keepIds].filter(Boolean));
  let removed = 0;
  let after;
  while (true) {
    const page = await client.vectorStores.files.list(VECTOR_STORE_ID, { limit: 100, after });
    for (const vsf of page.data) {
      if (keep.has(vsf.id)) continue;
      try {
        await client.vectorStores.files.del(VECTOR_STORE_ID, vsf.id);
        await client.files.del(vsf.id).catch(() => {});
        removed++;
      } catch (err) {
        console.warn('cleanup orphan fallo:', vsf.id, err.message);
      }
    }
    if (!page.has_more) break;
    after = page.data[page.data.length - 1]?.id;
    if (!after) break;
  }
  return { removed };
}
