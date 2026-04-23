// Parser y ensamblador para archivos .md multi-evento.
// Estructura esperada:
//   # Título del catálogo           (opcional, queda en preamble)
//   ... preamble ...
//   ## Eventos
//   ### Evento 1
//   ... contenido ...
//   ### Evento 2
//   ...
//   ## Cualquier otra sección       (rules / misc queda en footer)

export function parseMultiEventMd(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  let eventsHeadingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Eventos\s*$/i.test(lines[i].trim())) {
      eventsHeadingIdx = i;
      break;
    }
  }
  if (eventsHeadingIdx === -1) {
    // No tiene sección "## Eventos" — tratamos todo como preamble
    return { preamble: normalized.trim(), events: [], footer: '' };
  }

  let footerIdx = -1;
  for (let i = eventsHeadingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      footerIdx = i;
      break;
    }
  }

  const preamble = lines.slice(0, eventsHeadingIdx).join('\n').trimEnd();
  const eventsBlock = lines
    .slice(eventsHeadingIdx + 1, footerIdx === -1 ? lines.length : footerIdx)
    .join('\n');
  const footer = footerIdx === -1 ? '' : lines.slice(footerIdx).join('\n').trim();

  const events = [];
  const evLines = eventsBlock.split('\n');
  let current = null;
  for (const line of evLines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      if (current) events.push(finalize(current));
      current = { title: m[1].trim(), content: '' };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    }
  }
  if (current) events.push(finalize(current));

  return { preamble, events, footer };
}

function finalize(ev) {
  let content = ev.content.replace(/^\n+/, '').replace(/\n+$/, '');
  content = content.replace(/^(?:-{3,}\s*\n)+/g, '').replace(/(?:\n\s*-{3,}\s*)+$/g, '');
  content = content.trim();
  const imageUrls = extractImageUrls(content);
  return { title: ev.title, content, imageUrls };
}

export function extractImageUrls(text) {
  const urls = [];
  // Acepta URLs absolutas (http/https) o relativas servidas por la app (/mapas/...).
  const re = /MAPA_DE\s+"[^"]*"\s*(?:→|->)\s*((?:https?:\/\/|\/)\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    urls.push(m[1].trim().replace(/[),.]+$/, ''));
  }
  return urls;
}

export function assembleMultiEventMd({ preamble, events, footer }) {
  const parts = [];
  if (preamble && preamble.trim()) parts.push(preamble.trim());
  parts.push('## Eventos');
  const eventBlocks = events.map((e) => `### ${e.title}\n\n${e.content.trim()}`);
  parts.push(eventBlocks.join('\n\n---\n\n'));
  if (footer && footer.trim()) {
    parts.push('---');
    parts.push(footer.trim());
  }
  return parts.join('\n\n') + '\n';
}
