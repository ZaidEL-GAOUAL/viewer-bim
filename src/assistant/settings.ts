import type { ApiSettings } from './client.ts';

/** Accept either an OpenAI-compatible base URL or the full chat-completions URL. */
export function normalizeApiSettings(endpoint: string, apiKey: string, model: string): ApiSettings {
  let url: URL;
  try { url = new URL(endpoint.trim()); }
  catch { throw new Error('Saisissez une adresse d’API HTTPS valide.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('L’adresse doit utiliser HTTPS, sans identifiants ni paramètres.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  const key = apiKey.trim(), name = model.trim();
  if (!key || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('Saisissez une clé API valide.');
  if (!name || name.length > 200 || /[\r\n]/.test(name)) throw new Error('Saisissez le nom du modèle à utiliser.');
  return { endpoint: url.href, apiKey: key, model: name };
}
