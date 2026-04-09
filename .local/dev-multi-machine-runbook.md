# Multi-Machine Dev Runbook
∵ RCR Regis ∴

Procédure de déploiement et troubleshooting du fork claude-mem en mode client/serveur
sur la branche `feat/multi-machine-network`.

## Architecture

- **Serveur** : `macstudio-m3ultra-regis` — mode `server`, écoute sur `:37777`
- **Client** : `macstudio-m4max-regis` — mode `client`, proxy vers le serveur

Les deux machines exécutent le même fork depuis :
```
/Users/regis/Development/GitHub/thedotmack/claude-mem
```

Le plugin Claude Code charge le worker depuis la marketplace (`~/.claude/plugins/marketplaces/thedotmack/`),
qui est synchronisée depuis le fork via `sync-marketplace.cjs`.

## Problème connu : écrasement du working directory

Les fichiers sources du fork peuvent être écrasés silencieusement (par un outil, un sync, ou un rebase),
ce qui supprime le code multi-machine de `worker-service.ts` et des modules associés.
Le build produit alors un bundle sans proxy/network mode, et le worker démarre en mode standalone.

### Symptômes

- `http://0.0.0.0:37777/` retourne `{"error":"server_unreachable","serverHost":"..."}`
- Le health endpoint ne montre pas `"mode":"client"` ou `"mode":"server"`
- Le viewer affiche "Server unreachable"

### Diagnostic rapide

```bash
# Vérifier que le code multi-machine est dans les sources
grep -c "getNetworkMode\|ProxyServer" src/services/worker-service.ts
# Attendu : 9 (si 0, les sources ont été écrasées)

# Vérifier les fichiers modifiés/supprimés
git diff --name-status | wc -l
# Attendu : 0 (si > 0, le working directory a divergé du HEAD)

# Vérifier que le bundle contient le code
grep -c "getNetworkMode\|ProxyServer\|server_unreachable" plugin/scripts/worker-service.cjs
# Attendu : > 0 (si 0, le bundle a été buildé sans le code multi-machine)
```

## Procédure de restauration complète

### Prérequis

Les deux machines doivent être sur la branche `feat/multi-machine-network` avec des sources propres.

### Étape 1 — Restaurer les sources (sur chaque machine)

```bash
cd /Users/regis/Development/GitHub/thedotmack/claude-mem

# Vérifier la branche
git branch --show-current
# → feat/multi-machine-network

# Restaurer le working directory
git checkout -- .

# Si la branche est en retard sur origin
git fetch origin
git reset --hard origin/feat/multi-machine-network
```

### Étape 2 — Build

```bash
node scripts/build-hooks.js
```

Vérifier que la sortie contient :
- `✓ worker-service built` (~1900 KB, pas ~1888 KB)
- `✓ proxy-service built` (~27 KB)

### Étape 3 — Sync vers marketplace

```bash
node scripts/sync-marketplace.cjs
```

### Étape 4 — Restart du worker

```bash
bun ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs restart
```

### Étape 5 — Vérification

```bash
curl -s http://127.0.0.1:37777/api/health | python3 -m json.tool
```

Vérifier :
- `"mode": "server"` (sur macstudio-m3ultra-regis)
- `"mode": "client"` + `"proxy": true` + `"serverReachable": true` (sur macstudio-m4max-regis)

## Procédure sur le serveur distant (via SSH)

Le PATH n'est pas chargé en SSH non-interactif. Toujours préfixer :

```bash
ssh macstudio-m3ultra-regis "export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH && cd /Users/regis/Development/GitHub/thedotmack/claude-mem && <commande>"
```

### One-liner de restauration complète (serveur)

```bash
ssh macstudio-m3ultra-regis "export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH && cd /Users/regis/Development/GitHub/thedotmack/claude-mem && git fetch origin && git reset --hard origin/feat/multi-machine-network && node scripts/build-hooks.js && node scripts/sync-marketplace.cjs"
```

### One-liner de restauration complète (client local)

```bash
cd /Users/regis/Development/GitHub/thedotmack/claude-mem && git checkout -- . && node scripts/build-hooks.js && node scripts/sync-marketplace.cjs
```

## Après un reboot

Au reboot, le worker est relancé par les hooks du plugin Claude Code, qui chargent le bundle
depuis `~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs`.

Si le sync n'a pas été refait après un écrasement des sources, l'ancien bundle (sans multi-machine) sera chargé.

**Action** : après chaque reboot, vérifier le health endpoint. Si le mode n'est pas `client`/`server`,
relancer la procédure de restauration ci-dessus.

## Configuration (settings.json)

Fichier : `~/.claude-mem/settings.json`

Clés réseau :
- `CLAUDE_MEM_NETWORK_MODE` : `server` ou `client`
- `CLAUDE_MEM_SERVER_HOST` : hostname du serveur (ex: `macstudio-m3ultra-regis`)
- `CLAUDE_MEM_SERVER_PORT` : `37777`
- `CLAUDE_MEM_AUTH_TOKEN` : token partagé entre client et serveur
