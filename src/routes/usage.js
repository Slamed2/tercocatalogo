// GET /api/usage?days=7  → consumo del proyecto en los últimos N días.
//
// Requiere:
//   - OPENAI_ADMIN_KEY (admin API key con scope api.usage.read)
//   - OPENAI_PROJECT_ID (id del proyecto a filtrar — ej. proj_2UXG11t73...)
//
// La OpenAI Costs API expone /v1/organization/costs con buckets diarios y
// agrupación por line_item. Filtramos por project_ids para no exponer datos
// de otros proyectos de la org. La respuesta cruda trae varias filas por
// línea (1 por sub-proyecto/key), las agregamos por categoría.

import express from 'express';

const router = express.Router();

// Categorías "bonitas" para agrupar line_items que vienen con el modelo
// versionado (ej. "gpt-4.1-mini-2025-04-14, input").
function categorize(lineItem) {
  if (!lineItem) return 'otros';
  const li = lineItem.toLowerCase();
  if (li.includes('file search')) return 'file_search';
  if (li.includes('web search')) return 'web_search';
  if (li.includes('whisper')) return 'whisper';
  if (li.includes('vector_store') || li.includes('vector store')) return 'vector_store';
  // gpt-* → "gpt-4.1-mini, input" → categoría "gpt-4.1-mini · input"
  const m = li.match(/^(gpt-[\d.]+(?:-mini|-nano)?|gpt-4o(?:-mini)?)[^,]*,\s*(.+)$/);
  if (m) {
    const model = m[1].replace(/^gpt-/, 'gpt-');
    const kind = m[2].trim(); // input | output | cached input
    return `${model} · ${kind}`;
  }
  return lineItem;
}

// Markup configurable: porcentaje sobre el costo OpenAI desde una fecha dada.
// Ejemplo: USAGE_MARKUP_PCT=50 USAGE_MARKUP_FROM=2026-04-29 → todo lo que
// corresponde al 29/4 en adelante se multiplica por 1.5 cuando se reporta como
// `total_billable`. Los días anteriores se reportan al costo raw (1×).
function getMarkupConfig() {
  const pct = parseFloat(process.env.USAGE_MARKUP_PCT || '0');
  const from = process.env.USAGE_MARKUP_FROM || null; // 'YYYY-MM-DD' o null
  return { pct: isNaN(pct) ? 0 : pct, from };
}

function billableFor(dayKey, raw, cfg) {
  if (!cfg.pct || !cfg.from) return raw;
  if (dayKey >= cfg.from) return raw * (1 + cfg.pct / 100);
  return raw;
}

router.get('/', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 60);
  const projectId = process.env.OPENAI_PROJECT_ID;
  const adminKey = process.env.OPENAI_ADMIN_KEY;

  if (!adminKey || !projectId) {
    return res.status(503).json({
      error: 'Falta OPENAI_ADMIN_KEY o OPENAI_PROJECT_ID en el entorno.',
    });
  }

  const markup = getMarkupConfig();

  // Alineación a horario Argentina (UTC-3, sin DST). Los buckets de OpenAI se
  // alinean al `start_time` que pasamos, así que enviando "medianoche Argentina"
  // (= 03:00 UTC) cada bucket cubre un día completo de Argentina (00:00 → 24:00 ART).
  const ARG_OFFSET_HOURS = 3;
  const nowMs = Date.now();
  // "Hoy" en Argentina (correr el reloj 3h hacia atrás para encontrar el día ART actual).
  const argNow = new Date(nowMs - ARG_OFFSET_HOURS * 3600 * 1000);
  const y = argNow.getUTCFullYear();
  const m = argNow.getUTCMonth();
  const d = argNow.getUTCDate();
  // Medianoche Argentina del día actual, expresada en UTC seconds.
  const argTodayMidnightUtc = Date.UTC(y, m, d, ARG_OFFSET_HOURS) / 1000;
  const start = argTodayMidnightUtc - (days - 1) * 86400;

  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(start));
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('group_by', 'line_item');
  url.searchParams.set('project_ids', projectId);
  url.searchParams.set('limit', '180');

  let raw;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text.slice(0, 300) });
    }
    raw = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Falla al consultar OpenAI: ' + err.message });
  }

  // Agregar resultados: 1 fila por (día, categoría) sumando line_items duplicados.
  const byDay = {};
  for (const bucket of raw.data || []) {
    const dayKey = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
    const categories = {};
    let dayTotal = 0;
    for (const r of bucket.results || []) {
      const cat = categorize(r.line_item);
      // OpenAI a veces devuelve amount.value como string — forzar a número.
      const v = parseFloat(r.amount?.value) || 0;
      categories[cat] = (categories[cat] || 0) + v;
      dayTotal += v;
    }
    byDay[dayKey] = { total: dayTotal, categories };
  }

  // Producir array ordenado por día (ascendente) con todas las fechas del rango,
  // incluso días sin actividad (total=0) para que el gráfico no tenga huecos.
  // Cada día incluye `total` (costo raw OpenAI) y `total_billable` (con markup
  // si aplica desde USAGE_MARKUP_FROM).
  const series = [];
  for (let i = 0; i < days; i++) {
    const ts = start + i * 86400;
    const key = new Date(ts * 1000).toISOString().slice(0, 10);
    const rawTotal = byDay[key]?.total || 0;
    series.push({
      day: key,
      total: rawTotal,
      total_billable: billableFor(key, rawTotal, markup),
      categories: byDay[key]?.categories || {},
    });
  }

  // Métricas resumen — para `avg_per_day` y `monthly_projection` se usa la
  // versión con markup (es lo que vas a facturar al cliente).
  const total = series.reduce((s, d) => s + d.total, 0);
  const totalBillable = series.reduce((s, d) => s + d.total_billable, 0);
  const today = series[series.length - 1];
  const completedDays = series.slice(0, -1);
  const avgRaw = completedDays.length
    ? completedDays.reduce((s, d) => s + d.total, 0) / completedDays.length
    : today.total;
  const avgBillable = completedDays.length
    ? completedDays.reduce((s, d) => s + d.total_billable, 0) / completedDays.length
    : today.total_billable;

  res.json({
    project_id: projectId,
    days,
    today: {
      day: today.day,
      total: today.total,
      total_billable: today.total_billable,
      categories: today.categories,
    },
    summary: {
      total_period: total,
      total_period_billable: totalBillable,
      avg_per_day: avgRaw,
      avg_per_day_billable: avgBillable,
      monthly_projection: avgRaw * 30,
      monthly_projection_billable: avgBillable * 30,
    },
    markup: {
      pct: markup.pct,
      from: markup.from,
      active: markup.pct > 0 && !!markup.from,
    },
    series,
    generated_at: new Date().toISOString(),
  });
});

export default router;
