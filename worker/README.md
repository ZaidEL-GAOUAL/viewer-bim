# Worker « assistant »

Petit service Cloudflare Workers (plan gratuit, sans carte bancaire) qui relie le viewer à un
modèle de langage. Il garde les clés et le quota ; le viewer lui envoie la conversation (un
résumé des propriétés du modèle, les questions, les résultats des outils), jamais le fichier
entier. Les outils eux-mêmes (`src/assistant/tools.ts`) tournent dans le navigateur.

## Ce qu'il faut, une fois

1. Un compte Cloudflare (gratuit, e-mail seulement). Dans le tableau de bord, ouvrir
   **Workers & Pages** une première fois : Cloudflare demande de choisir un sous-domaine
   `*.workers.dev` ; c'est l'adresse publique du worker.
2. Un **jeton d'API** (My Profile → API Tokens → Create Token → modèle « Edit Cloudflare
   Workers »), et l'**identifiant du compte** (Account ID, affiché dans Workers & Pages, à droite).
3. Dans le dépôt GitHub : **Settings → Secrets and variables → Actions → New repository secret**,
   deux secrets : `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.

Le workflow de déploiement (`.github/workflows/deploy.yml`) déploie alors le worker à chaque
`git push`, puis construit le site avec son adresse. Sans ces secrets, le site se déploie sans
assistant (l'onglet l'indique).

Si l'adresse du worker n'est pas reprise automatiquement, la fixer à la main : **Settings →
Secrets and variables → Actions → Variables → `ASSISTANT_URL`** (par exemple
`https://viewer-bim-assistant.<sous-domaine>.workers.dev`).

## Modèles et relais

- Par défaut : **Workers AI**, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, dans le quota
  gratuit de 10 000 neurones par jour (≈ 90 à 130 requêtes avec nos outils). Au-delà, Cloudflare
  refuse jusqu'au lendemain ; rien n'est facturé.
- Relais facultatifs quand Workers AI refuse : **Groq** et **Cerebras** (paliers gratuits, sans
  carte). Créer une clé chez eux, puis dans Cloudflare → Workers & Pages → `viewer-bim-assistant`
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
