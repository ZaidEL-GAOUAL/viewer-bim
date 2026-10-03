# Worker « assistant »

Petit service Cloudflare Workers (plan gratuit, sans carte bancaire) qui relie le viewer à un
modèle de langage. Il garde les clés et le quota ; le viewer lui envoie la conversation (un
résumé des propriétés du modèle, les questions, les résultats des outils), jamais le fichier
entier. Les outils eux-mêmes (`src/assistant/tools.ts`) tournent dans le navigateur.

## Mise en place, une fois

Deux façons de déployer le worker ; la première ne demande aucun jeton.

**A. Cloudflare suit le dépôt Git** (Workers & Pages → Create → Import a repository, choisir
`viewer-bim`) :

| Champ | Valeur |
| --- | --- |
| Project / Worker name | `viewer-bim` |
| Root directory | `worker` |
| Build command | *(vide)* |
| Deploy command | `npx wrangler deploy` |

Cloudflare installe `wrangler` (version fixée dans `worker/package.json`) et déploie à chaque
push sur `main`. À la fin, il affiche l'adresse du worker :
`https://viewer-bim.<sous-domaine>.workers.dev`.

Puis, dans GitHub, dire au site où est le worker : **Settings → Secrets and variables →
Actions → onglet Variables → New repository variable** : `ASSISTANT_URL` = cette adresse.
Relancer le workflow (Actions → Run workflow) ou faire un push : le site est reconstruit avec.

**B. GitHub déploie le worker** (`.github/workflows/deploy.yml`) : deux secrets dans le dépôt,
`CLOUDFLARE_API_TOKEN` (jeton « Edit Cloudflare Workers ») et `CLOUDFLARE_ACCOUNT_ID`. Le
workflow déploie le worker puis construit le site avec son adresse. Sans ces secrets, cette
étape est sautée.

Dans les deux cas, sans adresse de worker, le site se déploie sans assistant (l'onglet
l'indique) ; tout le reste fonctionne.

## Modèles et relais

- Par défaut : **Workers AI**, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, dans le quota
  gratuit de 10 000 neurones par jour (≈ 80 questions par jour : chaque question coûte deux appels d’environ 1 800 jetons). Au-delà, Cloudflare
  refuse jusqu'au lendemain ; rien n'est facturé.
- Relais facultatifs quand Workers AI refuse : **Groq** et **Cerebras** (paliers gratuits, sans
  carte). Créer une clé chez eux, puis dans Cloudflare → Workers & Pages → `viewer-bim`
  → Settings → Variables and Secrets : `GROQ_API_KEY`, `CEREBRAS_API_KEY`. Modèles dans
  `wrangler.toml` (`GROQ_MODEL`, `CEREBRAS_MODEL`).
- `ALLOWED_ORIGINS` (`wrangler.toml`) : seuls ces sites peuvent appeler le worker. À compléter
  si le viewer est servi ailleurs.

## Protection du quota

- Origine vérifiée (`Origin`), 20 requêtes par minute et par adresse (binding « rate limit »),
  corps limité à 256 Ko, 80 messages, 20 outils.
- Les clés ne quittent jamais le worker.

## En local

```bash
cd worker && npx wrangler dev --remote
```

Le viewer en développement (`npm run dev`) appelle `http://localhost:8787` ; `--remote`
exécute le worker chez Cloudflare (nécessaire pour Workers AI).

## Protocole

- `GET /` → `{ ok, providers: [{ name, model }] }`.
- `POST /chat` avec `{ messages, tools }` au format « chat completions » (OpenAI) →
  `{ content, tool_calls: [{ id, name, arguments }], provider, model }`.
