const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const btnNuevo = document.getElementById('btn-nuevo');
const dlg = document.getElementById('dlg-nuevo');
const nuevoTitle = document.getElementById('nuevo-title');
const masterInfo = document.getElementById('master-info');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// Convierte una URL a su versión thumbnail si apunta a /mapas/.
// Soporta absolutas (https://.../mapas/x.png) y relativas (/mapas/x.png).
function toThumbUrl(url, width = 480) {
  if (!url) return url;
  const m = url.match(/\/mapas\/([^/?#]+)/);
  if (!m) return url;
  return `/thumb/${encodeURIComponent(m[1])}?w=${width}`;
}

async function load() {
  const r = await fetch('/api/events');
  const data = await r.json();
  const events = data.events || [];
  const withSync = events.filter((e) => e.openai_file_id).length;
  if (masterInfo) {
    const indexTxt = data.index?.openai_file_id
      ? ` · índice: ${data.index.openai_file_id}`
      : '';
    masterInfo.textContent = events.length
      ? `${events.length} eventos en el vector store (${withSync} sincronizados)${indexTxt}`
      : 'Sin eventos. Importá un .md o creá uno nuevo.';
  }
  grid.innerHTML = '';
  if (!events.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const e of events) {
    const card = document.createElement('a');
    card.className = 'card' + (e.is_rules ? ' card-rules' : '');
    card.href = `/editor/${encodeURIComponent(e.slug)}`;
    const img = e.is_rules
      ? '<span class="rules-icon">⚙</span>'
      : e.image
        ? `<img src="${toThumbUrl(e.image, 480)}" alt="" loading="lazy" decoding="async" />`
        : '<span>Sin imagen</span>';
    card.innerHTML = `
      <div class="card-img">${img}</div>
      <div class="card-body">
        <h3>${escapeHtml(e.title)}</h3>
        <small>${e.updated_at ? new Date(e.updated_at).toLocaleString() : ''}</small>
        ${e.openai_file_id ? `<small class="file-id">${e.openai_file_id}</small>` : '<small class="file-id warn">no sincronizado</small>'}
      </div>`;
    grid.appendChild(card);
  }
}

btnNuevo.addEventListener('click', () => {
  nuevoTitle.value = '';
  dlg.showModal();
});

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'default') return;
  const title = nuevoTitle.value.trim();
  if (!title) return;
  const r = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Error al crear');
    return;
  }
  const { slug } = await r.json();
  location.href = `/editor/${encodeURIComponent(slug)}`;
});

function showProgressOverlay(title) {
  const overlay = document.createElement('div');
  overlay.className = 'pull-overlay';
  overlay.innerHTML = `
    <div class="pull-card">
      <h3>${title}</h3>
      <div class="pull-text">Preparando…</div>
      <div class="pull-bar"><div class="pull-fill"></div></div>
      <div class="pull-count"></div>
    </div>`;
  document.body.appendChild(overlay);
  return {
    update(ev) {
      const text = overlay.querySelector('.pull-text');
      const fill = overlay.querySelector('.pull-fill');
      const count = overlay.querySelector('.pull-count');
      if (ev.type === 'listing') text.textContent = 'Listando archivos…';
      if (ev.type === 'start') {
        text.textContent = 'Preparando…';
        count.textContent = `0 / ${ev.total}`;
      }
      if (ev.type === 'writing') text.textContent = 'Escribiendo en disco…';
      if (ev.type === 'cleanup') text.textContent = 'Limpiando archivos viejos…';
      if (ev.type === 'progress') {
        text.textContent = ev.filename || '';
        count.textContent = `${ev.current} / ${ev.total}`;
        fill.style.width = `${(ev.current / ev.total) * 100}%`;
      }
      if (ev.type === 'error') {
        text.textContent = 'Error: ' + ev.error;
        fill.style.background = 'var(--danger, #e05353)';
      }
    },
    close() { overlay.remove(); },
  };
}

// Consume NDJSON del body y dispatches a ui.update por evento.
async function consumeNdjson(resp, ui) {
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;
  let errorMsg = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      ui.update(ev);
      if (ev.type === 'done') finalResult = ev.result;
      if (ev.type === 'error') errorMsg = ev.error;
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  return finalResult;
}

document.getElementById('btn-sync')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Subiendo…';
  const ui = showProgressOverlay('Subiendo a OpenAI');
  try {
    const r = await fetch('/api/events/sync', { method: 'POST' });
    const d = await consumeNdjson(r, ui);
    if (!d) throw new Error('Respuesta incompleta');
    const errTxt = d.errors?.length ? `\n\n${d.errors.length} fallaron` : '';
    alert(`Vector store actualizado ✓\n\n${d.events} eventos${d.rules ? ' + reglas' : ''}${d.catalog ? ' + catálogo' : ''}${errTxt}`);
    await load();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    ui.close();
    btn.disabled = false;
    btn.textContent = orig;
  }
});

load();
