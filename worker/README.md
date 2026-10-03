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
  gratuit de 10 000 neurones par jour (≈ 60 questions par jour : chaque question coûte deux appels d’environ 2 500 jetons). Au-delà, Cloudflare
  refuse jusqu'au lendemain ; rien n'est facturé.
- Relais facultatifs quand Workers AI refuse : **Groq** et **Cerebras** (paliers gratuits, sans
  carte). Créer une clé chez eux, puis dans Cloudflare → Workers & Pages → `viewer-bim`
  → Settings → Variables and Secrets : `GROQ_API_KEY`, `CEREBRAS_API_KEY`. Modèles dans
  `wrangler.toml` (`GROQ_MODEL`, `CEREBRAS_MODEL`).
- `ALLOWED_ORIGINS` (`wrangler.toml`) : seuls ces sites peuvent appeler le worker. À compléter
  si le viewer est servi ailleurs.

## API personnelle ou d’entreprise

Dans l’onglet Assistant, ouvrir **Paramètres de l’API**, choisir un fournisseur puis renseigner
l’adresse de base, le modèle et la clé. Les appels passent toujours par le worker. La clé
reste en mémoire dans l’onglet et accompagne chaque requête HTTPS au relais ; elle n’est
enregistrée ni dans le navigateur, ni dans la conversation, ni par le worker. Recharger
la page ou choisir **Service du site** efface cette configuration. Aucun appel au modèle
n’est effectué lors de l’enregistrement des réglages.

Les endpoints OpenAI, Groq et Cerebras proposés sont autorisés par défaut. Pour un autre
service compatible avec `chat/completions`, l’administrateur ajoute son URL HTTPS complète
dans la variable Cloudflare **`AI_ALLOWED_ENDPOINTS`** (plusieurs URLs séparées par des
virgules), par exemple `https://gateway.example.com/openai/v1/chat/completions`.
L’URL doit correspondre exactement : les hôtes locaux, adresses IP, paramètres d’URL,
identifiants intégrés et redirections sont refusés. Une configuration personnelle ne
bascule pas vers les fournisseurs du site en cas d’erreur.

Le compteur affiche les jetons d’entrée, de sortie et le total déclarés par les fournisseurs
pendant la session, y compris les étapes d’outils. Un `?` indique une consommation non
communiquée (réponse sans usage, requête interrompue ou tentative échouée) ; aucune
estimation n’est inventée. **Nouvelle conversation** conserve ce compteur ; recharger
la page le remet à zéro.

## Protection du quota

- Origine vérifiée (`Origin`), 20 requêtes par minute et par adresse (binding « rate limit »),
  corps limité à 256 Ko, 80 messages, 20 outils.
- Les clés du service restent dans le worker. Une clé personnelle est transmise uniquement
  au relais puis à l’endpoint autorisé choisi, sans journalisation de la clé ou des erreurs
  brutes du fournisseur.

## En local

```bash
cd worker && npx wrangler dev --remote
```

Le viewer en développement (`npm run dev`) appelle `http://localhost:8787` ; `--remote`
exécute le worker chez Cloudflare (nécessaire pour Workers AI).

## Protocole

- `GET /` → `{ ok, providers: [{ name, model }] }`.
- `POST /chat` avec `{ messages, tools, api? }` au format « chat completions » (OpenAI).
  `api`, facultatif, vaut `{ endpoint, apiKey, model }` et ne fait jamais partie des messages.
- Réponse : `{ content, tool_calls: [{ id, name, arguments }], provider, model, usage }`.
  `usage` contient `{ inputTokens, outputTokens, totalTokens }` ; chaque valeur est un entier
  mesuré ou `null` si elle n’est pas disponible. `unreportedAttempts`, facultatif, compte
  les tentatives précédentes sans mesure retournée.
