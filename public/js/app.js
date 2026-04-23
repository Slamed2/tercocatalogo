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

load();
