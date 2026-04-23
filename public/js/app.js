const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const noResults = document.getElementById('no-results');
const btnNuevo = document.getElementById('btn-nuevo');
const dlg = document.getElementById('dlg-nuevo');
const nuevoTitle = document.getElementById('nuevo-title');
const masterInfo = document.getElementById('master-info');
const searchInput = document.getElementById('search');

// Normaliza texto para búsqueda: minúsculas, sin acentos, sin whitespace extra.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Todos los eventos cargados (fuente de verdad para el filtro).
let allEvents = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// Convierte una URL a su versión thumbnail si apunta a /mapas/.
// Soporta:
//  - /mapas/file.png              → /thumb/file.png (legacy plano)
//  - /mapas/<slug>/file.png       → /thumb/<slug>/file.png (nuevo)
//  - https://.../mapas/... también (absoluta o relativa).
function toThumbUrl(url, width = 480) {
  if (!url) return url;
  const m = url.match(/\/mapas\/([^?#]+)/);
  if (!m) return url;
  const parts = m[1].split('/').map(encodeURIComponent).join('/');
  return `/thumb/${parts}?w=${width}`;
}

function renderGrid(events) {
  grid.innerHTML = '';
  if (!events.length) {
    grid.hidden = true;
    return;
  }
  grid.hidden = false;
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

function applyFilter() {
  const q = normalize(searchInput?.value);
  empty.hidden = allEvents.length > 0;
  if (!allEvents.length) {
    grid.innerHTML = '';
    grid.hidden = true;
    noResults.hidden = true;
    return;
  }
  if (!q) {
    renderGrid(allEvents);
    noResults.hidden = true;
    return;
  }
  const filtered = allEvents.filter((e) => normalize(e.title).includes(q) || normalize(e.slug).includes(q));
  renderGrid(filtered);
  noResults.hidden = filtered.length > 0;
}

async function load() {
  const r = await fetch('/api/events');
  const data = await r.json();
  allEvents = data.events || [];
  const withSync = allEvents.filter((e) => e.openai_file_id).length;
  if (masterInfo) {
    const indexTxt = data.index?.openai_file_id
      ? ` · índice: ${data.index.openai_file_id}`
      : '';
    masterInfo.textContent = allEvents.length
      ? `${allEvents.length} eventos en el vector store (${withSync} sincronizados)${indexTxt}`
      : 'Sin eventos. Importá un .md o creá uno nuevo.';
  }
  applyFilter();
}

searchInput?.addEventListener('input', applyFilter);

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
