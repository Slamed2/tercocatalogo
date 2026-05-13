const slug = decodeURIComponent(location.pathname.split('/').pop());
const titleEl = document.getElementById('title');
const btnSave = document.getElementById('btn-save');
const btnDel = document.getElementById('btn-del');
const preview = document.getElementById('preview');
const previewEmpty = document.getElementById('preview-empty');
const fileInput = document.getElementById('file');
const metaSlug = document.getElementById('meta-slug');
const metaMasterFile = document.getElementById('meta-file');
const metaUpdated = document.getElementById('meta-updated');
const toast = document.getElementById('toast');
const mapsList = document.getElementById('maps-list');
const mapsEmpty = document.getElementById('maps-empty');
const btnAddMap = document.getElementById('btn-add-map');
const btnAddMapLabel = document.getElementById('btn-add-map-label');

const MAP_LINE_RE = /^(\s*-?\s*MAPA_DE\s+"([^"]*)"\s*→\s*)(\S+)(.*)$/;

let mapMarkers = []; // array de TextMarker, index alineado con los bloques del sidebar

function parseMapLineTxt(lineText) {
  const m = MAP_LINE_RE.exec(lineText);
  if (!m) return null;
  return { prefix: m[1], label: m[2], url: m[3], suffix: m[4] };
}

function applyMapMarkers() {
  const cm = editor.codemirror;
  mapMarkers.forEach((mk) => mk.clear());
  mapMarkers = [];
  for (let i = 0; i < cm.lineCount(); i++) {
    const lineText = cm.getLine(i);
    const parsed = parseMapLineTxt(lineText);
    if (!parsed) continue;
    const mark = cm.markText(
      { line: i, ch: 0 },
      { line: i, ch: lineText.length },
      {
        readOnly: true,
        atomic: true,
        inclusiveRight: true,
        className: 'map-readonly-line',
      }
    );
    mapMarkers.push(mark);
  }
}

function collectMapsFromEditor() {
  const cm = editor.codemirror;
  const maps = [];
  mapMarkers.forEach((mk) => {
    const pos = mk.find();
    if (!pos) return;
    const lineText = cm.getLine(pos.from.line);
    const parsed = parseMapLineTxt(lineText);
    if (parsed) maps.push({ line: pos.from.line, ...parsed });
  });
  return maps;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMaps() {
  const maps = collectMapsFromEditor();
  mapsList.innerHTML = '';
  btnAddMapLabel.firstChild.textContent = maps.length
    ? '+ Agregar más imágenes al mapa'
    : '+ Agregar mapa';
  if (!maps.length) {
    mapsEmpty.hidden = false;
    return;
  }
  mapsEmpty.hidden = true;
  maps.forEach((map, idx) => {
    const item = document.createElement('div');
    item.className = 'map-item';
    item.innerHTML = `
      <div class="map-label">Mapa ${idx + 1} — ${escapeHtml(map.label)}</div>
      <div class="map-img-box">
        <img class="map-img" alt="" src="${escapeHtml(map.url)}" onerror="this.style.display='none';this.nextElementSibling.hidden=false;">
        <div class="map-img-fail" hidden>No se pudo cargar la imagen</div>
      </div>
      <input class="map-url" type="url" value="${escapeHtml(map.url)}" placeholder="URL de la imagen" />
      <div class="map-actions">
        <label class="btn btn-secondary file-label">
          Reemplazar
          <input class="map-file" type="file" accept="image/*" hidden />
        </label>
        <button type="button" class="btn btn-danger btn-del-map">Eliminar</button>
      </div>
    `;
    const urlInput = item.querySelector('.map-url');
    const imgEl = item.querySelector('.map-img');
    const failEl = item.querySelector('.map-img-fail');
    const fileEl = item.querySelector('.map-file');
    const btnDelMap = item.querySelector('.btn-del-map');

    urlInput.addEventListener('change', () => {
      updateMapUrl(idx, urlInput.value.trim());
      imgEl.style.display = '';
      failEl.hidden = true;
      imgEl.src = urlInput.value.trim();
    });

    fileEl.addEventListener('change', async () => {
      const f = fileEl.files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('map', f);
      try {
        const r = await fetch(`/api/events/${encodeURIComponent(slug)}/map`, { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al subir');
        updateMapUrl(idx, data.url);
        urlInput.value = data.url;
        imgEl.style.display = '';
        failEl.hidden = true;
        imgEl.src = data.url + '?t=' + Date.now();
        showToast('Mapa actualizado ✓');
      } catch (err) {
        showToast(err.message, true);
      }
    });

    btnDelMap.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el mapa "${map.label}"?\n\nSaca la línea MAPA_DE del evento y borra la imagen del storage.`)) return;
      try {
        // 1) Borrar de event_media (DB). Extraer filename de la URL.
        const filename = (map.url.match(/\/mapas\/[^/]+\/([^?#]+)/) || [])[1];
        if (filename) {
          const r = await fetch(
            `/api/events/${encodeURIComponent(slug)}/map?filename=${encodeURIComponent(filename)}`,
            { method: 'DELETE' }
          );
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error || `HTTP ${r.status}`);
          }
        }
        // 2) Sacar la línea MAPA_DE del editor.
        removeMapLine(idx);
        showToast('Mapa eliminado ✓');
      } catch (err) {
        showToast('Error: ' + err.message, true);
      }
    });

    mapsList.appendChild(item);
  });
}

// Borra la línea MAPA_DE en la posición indicada y re-renderiza los markers.
function removeMapLine(idx) {
  const cm = editor.codemirror;
  const marker = mapMarkers[idx];
  if (!marker) return;
  const pos = marker.find();
  if (!pos) return;
  const line = pos.from.line;
  cm.operation(() => {
    marker.clear();
    // Borrar la línea completa, incluido el salto de línea.
    const from = { line, ch: 0 };
    const to = line + 1 < cm.lineCount()
      ? { line: line + 1, ch: 0 }
      : { line, ch: cm.getLine(line).length };
    cm.replaceRange('', from, to);
  });
  applyMapMarkers();
  renderMaps();
}

function updateMapUrl(idx, newUrl) {
  const cm = editor.codemirror;
  const marker = mapMarkers[idx];
  if (!marker) return;
  const pos = marker.find();
  if (!pos) return;
  const line = pos.from.line;
  const lineText = cm.getLine(line);
  const parsed = parseMapLineTxt(lineText);
  if (!parsed) return;
  const startCh = parsed.prefix.length;
  const endCh = startCh + parsed.url.length;
  cm.operation(() => {
    marker.clear();
    cm.replaceRange(newUrl, { line, ch: startCh }, { line, ch: endCh });
    const newLineText = cm.getLine(line);
    const newMark = cm.markText(
      { line, ch: 0 },
      { line, ch: newLineText.length },
      { readOnly: true, atomic: true, inclusiveRight: true, className: 'map-readonly-line' }
    );
    mapMarkers[idx] = newMark;
  });
}

metaSlug.textContent = slug;

const editor = new EasyMDE({
  element: document.getElementById('editor'),
  spellChecker: false,
  status: ['lines', 'words'],
  autosave: { enabled: false },
  toolbar: [
    'bold', 'italic', 'heading', '|',
    'quote', 'unordered-list', 'ordered-list', '|',
    'link', 'image', 'table', 'horizontal-rule', '|',
    'preview', 'side-by-side', 'fullscreen', '|',
    'guide',
  ],
});

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.classList.toggle('err', isError);
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 3500);
}

function setImage(url) {
  if (url) {
    const sep = url.includes('?') ? '&' : '?';
    preview.src = url.startsWith('/') ? url + sep + 't=' + Date.now() : url;
    preview.style.display = 'block';
    previewEmpty.style.display = 'none';
  } else {
    preview.style.display = 'none';
    previewEmpty.style.display = 'flex';
  }
}

async function load() {
  const r = await fetch(`/api/events/${encodeURIComponent(slug)}`);
  if (!r.ok) {
    alert('No se pudo cargar el evento');
    location.href = '/';
    return;
  }
  const data = await r.json();
  titleEl.value = data.title || '';
  editor.value(data.content || '');
  metaMasterFile.textContent = data.openai_file_id || '—';
  metaUpdated.textContent = data.updated_at ? new Date(data.updated_at).toLocaleString() : '—';
  applyMapMarkers();
  renderMaps();
  if (data.image) {
    setImage(data.image);
  } else {
    const maps = collectMapsFromEditor();
    setImage(maps[0]?.url || null);
  }
}

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  btnSave.textContent = 'Guardando…';
  try {
    const r = await fetch(`/api/events/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: titleEl.value.trim(), content: editor.value() }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Error');
    }
    const data = await r.json();
    metaMasterFile.textContent = data.openai_file_id || '—';
    metaUpdated.textContent = new Date().toLocaleString();
    if (data.synced) {
      showToast('Guardado y sincronizado con OpenAI ✓');
    } else if (data.sync_error) {
      showToast('Guardado ✓ (sync falló: ' + data.sync_error + ')', true);
    } else {
      showToast('Guardado ✓');
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = 'Guardar y sincronizar';
  }
});

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('image', f);
  const r = await fetch(`/api/events/${encodeURIComponent(slug)}/image`, { method: 'POST', body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    showToast(err.error || 'Error al subir', true);
    return;
  }
  const data = await r.json();
  setImage(data.image);
  showToast('Imagen actualizada ✓');
});

async function uploadMapFile(file) {
  const fd = new FormData();
  fd.append('map', file);
  const r = await fetch(`/api/events/${encodeURIComponent(slug)}/map`, { method: 'POST', body: fd });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Error al subir');
  return data.url;
}

btnAddMap.addEventListener('change', async () => {
  const f = btnAddMap.files?.[0];
  if (!f) return;
  const label = (prompt('Etiqueta del mapa (ej: Ingreso, Sector campo):', titleEl.value.trim() || 'Mapa') || '').trim();
  if (!label) { btnAddMap.value = ''; return; }
  try {
    const url = await uploadMapFile(f);
    const cm = editor.codemirror;
    const current = cm.getValue();
    const line = `- MAPA_DE "${label}" → ${url}`;
    const newContent = current.endsWith('\n') || current === '' ? `${current}${line}\n` : `${current}\n\n${line}\n`;
    cm.setValue(newContent);
    applyMapMarkers();
    renderMaps();
    if (preview.style.display === 'none') setImage(url);
    showToast('Mapa agregado ✓');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btnAddMap.value = '';
  }
});

btnDel.addEventListener('click', async () => {
  if (!confirm('¿Eliminar este evento y quitarlo del vector store?')) return;
  const r = await fetch(`/api/events/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  if (r.ok) location.href = '/';
  else showToast('Error al eliminar', true);
});

load();
