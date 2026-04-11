# Multi-Node Dev Runbook
∵ RCR Regis ∴

Déploiement, validation et troubleshooting du fork claude-mem en mode multi-node.
Branche : `feat/multi-node-v2`

## Architecture

| Node | Mode | Rôle | Worker path |
|------|------|------|-------------|
| MSM3U (macstudio-m3ultra-regis) | server | DB centralisée, processing AI | `~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/worker-service.cjs` |
| MSM4M (macstudio-m4max-regis) | client | Proxy → serveur, dev principale | `~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/proxy-service.cjs` |
| MBPM5M (mbp-m5max-regis) | client | Roaming | idem |
| MBPM4M (mbp-m4max-regis) | client | Legacy | idem |

**Important** : le worker charge depuis le **cache** (`~/.claude/plugins/cache/`), PAS depuis la marketplace.

## Procédure de déploiement

### 1. Build

```bash
cd /Users/regis/Development/GitHub/thedotmack/claude-mem
npm run build
```

### 2. Sync local

```bash
rsync -a plugin/ ~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/
```

### 3. Sync serveur (MSM3U)

```bash
rsync -az --delete plugin/ MSM3U:~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/
```

### 4. Sync clients (MBPM5M, MBPM4M)

```bash
rsync -az --delete plugin/ MBPM5M:~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/
rsync -az --delete plugin/ MBPM4M:~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/
```

### 5. Restart workers

```bash
# Serveur
ssh MSM3U 'kill $(lsof -ti :37777) 2>/dev/null; sleep 2; nohup /opt/homebrew/bin/bun ~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/worker-service.cjs > /dev/null 2>&1 &'

# Client local
kill $(lsof -ti :37777) 2>/dev/null; sleep 2
nohup bun ~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/proxy-service.cjs > /dev/null 2>&1 &

# Clients distants (bun PAS dans le PATH SSH — utiliser le chemin complet)
for node in MBPM5M MBPM4M; do
  ssh $node 'kill $(lsof -ti :37777) 2>/dev/null; sleep 2; nohup /opt/homebrew/bin/bun ~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/scripts/proxy-service.cjs > /dev/null 2>&1 &'
done
```

### 6. Vérification

```bash
# Serveur
ssh MSM3U 'curl -s http://localhost:37777/api/health' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"mode={d['mode']} status={d['status']}\")"

# Client local (attendre ~10s pour la connexion au serveur)
sleep 10
curl -s http://localhost:37777/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"mode={d['mode']} server={d.get('serverReachable')}\")"
```

### 7. Validation E2E (OBLIGATOIRE avant staging/upstream)

```bash
bash .local/tests/e2e/multi-node-validation.sh
```

78 tests, 8 layers, 0 fail, 0 skip requis. Voir le runbook E2E ci-dessous.

## Gotchas

| Problème | Cause | Fix |
|----------|-------|-----|
| `bun: not found` via SSH | PATH non-interactif | `/opt/homebrew/bin/bun` |
| `Server unreachable` dans le viewer | Proxy pas encore connecté | Attendre 10-15s après restart |
| Viewer 401 sur le serveur | Static assets servis après auth | middleware.ts: `express.static` AVANT `createAuthMiddleware` |
| Pills provenance absentes après refresh | PaginationHelper sans colonnes node/platform | Vérifier les SELECT dans PaginationHelper.ts |
| Observations non générées (obsCount=0) | SDK "Not logged in" | Vérifier `claude --version` sur le node serveur |
| Deploy au mauvais path | Sync vers marketplace au lieu de cache | Toujours `~/.claude/plugins/cache/thedotmack/claude-mem/12.1.0/` |
| Node provenance = serveur au lieu de client | Headers proxy pas lus par le handler | Tous les handlers doivent utiliser `getRequestProvenance(req)` |
| Prompts n'apparaissent pas en live | `broadcastNewPrompt` manquant dans ByClaudeId | Vérifier que CHAQUE handler ByClaudeId broadcast via SSE |
| Un type de message régresse indépendamment | Provenance codée séparément par type | Utiliser le middleware centralisé, jamais lire les headers directement |

## Configuration (settings.json)

Fichier : `~/.claude-mem/settings.json`

| Clé | Valeur serveur | Valeur client |
|-----|----------------|---------------|
| `CLAUDE_MEM_NETWORK_MODE` | `server` | `client` |
| `CLAUDE_MEM_SERVER_HOST` | _(vide)_ | `macstudio-m3ultra-regis` |
| `CLAUDE_MEM_AUTH_TOKEN` | `<token partagé>` | `<même token>` |

---

# Runbook E2E — Multi-Node Validation

## Prérequis

- Playwright : `npm install -D playwright && npx playwright install chromium`
- ImageMagick : `brew install imagemagick`
- Worker local + serveur en marche

## Lancement

```bash
bash .local/tests/e2e/multi-node-validation.sh
```

## Les 8 Layers

### Layer 1 — Schema & Migrations (13 tests)
Vérifie que `node`, `platform`, `instance`, `llm_source` existent dans `observations`, `user_prompts`, `session_summaries`. Teste aussi la création d'une DB fraîche.

### Layer 2 — Build & Bundle (8 tests)
- `npm run build` passe
- `worker-service.cjs` contient `NETWORK_MODE`
- `proxy-service.cjs` contient `Authorization`, `serverHost`, SSE forwarding
- `viewer-bundle.js` contient les card types, `meta-pills`, taille > 200KB

### Layer 3 — API Verification (6 tests)
- Health endpoints (local + serveur)
- `/api/observations`, `/api/prompts`, `/api/summaries` retournent la colonne `node`
- `/stream` SSE délivre `initial_load` dans les 5s

### Layer 4 — Provenance E2E (3 tests)
- Les observations récentes ont `node` + `platform` non-null en DB
- Les prompts ont la provenance
- Cohérence API ↔ DB serveur

### Layer 5 — Deployment Verification (4 tests)
- Hash MD5 du cache local = build output
- Hash MD5 du cache serveur = build output
- Version match proxy ↔ serveur
- Serveur joignable depuis le proxy

### Layer 6 — Network Behavior (4 tests)
- 401 sans token sur le serveur
- 200 avec token
- 403 pour les routes admin via le proxy
- SSE à travers le proxy avec comptage de projets

### Layer 7a — Visual Client (19 tests)
Playwright headless sur `localhost:37777` :
- Page titre, header version, mode client
- Composition du feed : observation types (≥2 types), prompts, summaries
- **SSE state** : node pills, platform pills (avant refresh)
- Screenshot SSE capturé
- **Refresh → Pagination state** : observations persistent, pills persistent
- **SSE ↔ Pagination delta** : observations ≤2, pills ≤5
- Screenshot pagination capturé
- ID pills, date pills, console toggle
- **Comparaison référence ImageMagick** : RMSE < 15000

### Layer 7b — Visual Server (4 tests)
- Viewer HTML servi sans auth (200)
- `viewer-bundle.js` accessible (200)
- SSE avec auth délivre `initial_load`
- API retourne observations avec provenance

### Layer 8 — Log Analysis (17 tests)
Analyse en 3 phases temporelles :

**Avant les tests (baseline)** :
- Pas d'ERROR, pas de "Not logged in", pas d'exceptions
- Mode-aware : en client, pas de STORED/SSE broadcasts locaux = PASS

**Pendant les tests** :
- En client : pas de log locaux = PASS attendu
- En standalone/server : doit générer des logs

**Serveur** :
- Pas d'ERROR, pas de "Not logged in", pas d'exceptions
- Observations stockées (stored > 0)
- SSE broadcasting actif
- Parser warnings ≤ 15 (issue #1312 connue)

**Après les tests** :
- Pas de crashes (FATAL/SIGKILL)
- Worker local toujours en vie
- Serveur toujours healthy

## Artefacts

| Type | Chemin |
|------|--------|
| Rapport | `.local/tests/e2e/reports/validation-<timestamp>.md` |
| Screenshots SSE | `.local/tests/e2e/reports/screenshots/viewer-<timestamp>-client-sse.png` |
| Screenshots Pagination | `.local/tests/e2e/reports/screenshots/viewer-<timestamp>-client-pagination.png` |
| Screenshots Référence | `.local/tests/e2e/reference-screenshots/client-reference.png` |

## Règles

- **0 fail, 0 skip** requis pour le verdict READY FOR UPSTREAM
- **Un skip est un angle mort** — chaque test doit être pass ou fail
- **Jamais de force-push** après un fix — nouveau commit uniquement
- **Jamais de fix aveugle** — rebuild → deploy → re-run validation après chaque changement
