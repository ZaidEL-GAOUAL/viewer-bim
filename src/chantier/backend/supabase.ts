// L'adaptateur Supabase de l'interface `BackendPort` (@supabase/supabase-js, MIT). Chargé à la demande : seulement par
// chantier.html, et par le viewer quand une maquette est liée à un projet. La page ne tient que l'adresse du projet et sa clé
// publique (publiques par nature) : les droits sont dans la base (row-level security), voir supabase/migrations/.

import { createClient } from '@supabase/supabase-js';
import { BackendError, cursorColumn, type Account, type BackendPort, type Change, type Row } from './port.ts';

const BUCKET = 'photos';
const PAGE = 1000;
/** La même clé pour toutes les pages du site : le viewer lié retrouve la session ouverte dans le suivi de chantier. */
const SESSION_KEY = 'suivi-de-chantier.session';

const AUTH_MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: 'E-mail ou mot de passe incorrect.',
  email_not_confirmed: 'Adresse e-mail pas encore confirmée : ouvrez le lien reçu par e-mail.',
  user_already_exists: 'Un compte existe déjà avec cette adresse.',
  weak_password: 'Mot de passe trop faible : 8 caractères au moins.',
  over_email_send_rate_limit: 'Trop d’e-mails envoyés pour le moment : réessayez dans une heure.',
  over_request_rate_limit: 'Trop de tentatives : réessayez dans quelques minutes.',
  signup_disabled: 'Les inscriptions sont fermées.',
};

/**
 * Une erreur de Supabase en `BackendError`. Pas de réponse, ou une erreur du serveur (5xx, projet en pause) : hors ligne,
 * rien n'est perdu. 401 : session expirée. Le reste : refus, avec le message du serveur.
 */
function failure(error: unknown, status?: number): BackendError {
  const value = (error ?? {}) as { message?: string; code?: string; status?: number; statusCode?: string; name?: string };
  const message = value.message ?? String(error);
  const code = status ?? value.status ?? (Number(value.statusCode) || undefined);
  if (value.name === 'AuthRetryableFetchError' || !code || code >= 500 || /failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return new BackendError('offline', 'Serveur injoignable (pas de réseau, ou serveur en pause) : vos données sont gardées sur cet appareil.');
  }
  if (value.code && Object.hasOwn(AUTH_MESSAGES, value.code)) return new BackendError(value.code === 'invalid_credentials' || value.code === 'email_not_confirmed' ? 'auth' : 'refused', AUTH_MESSAGES[value.code]);
  if (code === 401) return new BackendError('auth', 'Session expirée : reconnectez-vous.');
  if (code === 403 || value.code === '42501') return new BackendError('refused', `Refusé par le serveur : vous n’avez pas ce droit dans ce projet.`);
  return new BackendError('refused', `Refusé par le serveur : ${message}`);
}

export function supabaseBackend(url: string, key: string): BackendPort {
  const client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: SESSION_KEY } });
  const accountOf = (user: { id: string; email?: string } | null | undefined): Account | null => (user?.email ? { userId: user.id, email: user.email.toLowerCase() } : null);

  return {
    async account() {
      const { data, error } = await client.auth.getSession();
      if (error) throw failure(error);
      return accountOf(data.session?.user);
    },

    async signUp(email, password, displayName) {
      const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: location.href.split('#')[0] } });
      if (error) throw failure(error);
      return { confirmEmail: !data.session };
    },

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw failure(error);
      const account = accountOf(data.user);
      if (!account) throw new BackendError('auth', 'Compte sans adresse e-mail.');
      return account;
    },

    async signOut() {
      // Locale : se déconnecter marche aussi hors ligne.
      await client.auth.signOut({ scope: 'local' });
    },

    async pull(table, filter) {
      const column = cursorColumn(table);
      const rows: Row[] = [];
      for (let from = 0; ; from += PAGE) {
        let query = client.from(table).select('*');
        if (filter.projectId) query = query.eq(table === 'projects' ? 'id' : 'project_id', filter.projectId);
        if (filter.since) query = query.gte(column, filter.since);
        const { data, error, status } = await query.order(column, { ascending: true }).order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw failure(error, status);
        rows.push(...(data as Row[]));
        if (data.length < PAGE) return rows;
      }
    },

    async push(change: Change) {
      const { table, id, op, fields } = change;
      if (op === 'insert') {
        const { error, status } = await client.from(table).upsert({ ...fields, id }, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw failure(error, status);
      } else if (op === 'update') {
        const { data, error, status } = await client.from(table).update(fields).eq('id', id).select('id');
        if (error) throw failure(error, status);
        if (data.length === 0) throw new BackendError('refused', 'Modification refusée : introuvable sur le serveur, ou vous n’avez pas ce droit.');
      } else {
        const { error, status } = await client.from(table).delete().eq('id', id);
        if (error) throw failure(error, status);
      }
    },

    async upload(path, blob) {
      const { error } = await client.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: blob.type || 'image/jpeg', cacheControl: '31536000' });
      // Nommé par son contenu : déjà là, c'est le même fichier.
      if (error && !/already exists|duplicate/i.test(error.message) && (error as { statusCode?: string }).statusCode !== '409') throw failure(error);
    },

    async download(path) {
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error) throw failure(error);
      return data;
    },

    async remove(paths) {
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await client.storage.from(BUCKET).remove(paths.slice(i, i + 100));
        if (error) throw failure(error);
      }
    },

    async deleteAccount() {
      const { error, status } = await client.rpc('delete_my_account');
      if (error) throw failure(error, status);
      await client.auth.signOut({ scope: 'local' });
    },
  };
}
