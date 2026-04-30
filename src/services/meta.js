// Cliente para Meta Graph API (Instagram Stories).
//
// Variables de entorno requeridas:
//   META_GRAPH_TOKEN: access token (user o page) con permisos de
//     `instagram_basic`, `instagram_manage_insights` y `pages_show_list`.
//   META_IG_USER_ID: ID del Instagram Business Account.
//
// Si no tenés el IG_USER_ID, podés obtenerlo con tu token corriendo:
//   curl "https://graph.facebook.com/v25.0/me?fields=accounts{instagram_business_account{id,username}}&access_token=TOKEN"

const API_VERSION = 'v25.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function getConfig() {
  const token = process.env.META_GRAPH_TOKEN;
  const igUserId = process.env.META_IG_USER_ID;
  if (!token || !igUserId) {
    throw new Error(
      'META_GRAPH_TOKEN o META_IG_USER_ID no configurados. ' +
      'Agregalos al .env (ver src/services/meta.js para detalles).'
    );
  }
  return { token, igUserId };
}

// Devuelve la lista de stories activas (las que están publicadas en este momento).
// Las stories de Instagram expiran a las 24h, así que esta lista cambia con el tiempo.
export async function fetchActiveStories() {
  const { token, igUserId } = getConfig();
  const url = new URL(`${BASE_URL}/${igUserId}/stories`);
  url.searchParams.set('fields', 'id,media_url,media_type,timestamp,permalink,thumbnail_url');
  url.searchParams.set('access_token', token);

  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph API ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.data || [];
}

// Devuelve los últimos N posts/reels publicados (default: 25). Trae también
// caption (descripción), media_type, thumbnail/media URL y conteo de comentarios.
// La API ordena por más reciente.
export async function fetchRecentPosts(limit = 25) {
  const { token, igUserId } = getConfig();
  const url = new URL(`${BASE_URL}/${igUserId}/media`);
  url.searchParams.set(
    'fields',
    'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count'
  );
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  url.searchParams.set('access_token', token);

  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph API ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.data || [];
}

// Helper para descubrir el IG Business Account ID a partir del token.
// Útil para configuración inicial.
export async function discoverIgUserId(token) {
  const url = new URL(`${BASE_URL}/me`);
  url.searchParams.set('fields', 'accounts{instagram_business_account{id,username},name}');
  url.searchParams.set('access_token', token);

  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Graph API ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  const accounts = data.accounts?.data || [];
  return accounts
    .filter((a) => a.instagram_business_account)
    .map((a) => ({
      page_name: a.name,
      ig_id: a.instagram_business_account.id,
      ig_username: a.instagram_business_account.username,
    }));
}
