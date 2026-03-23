# Test Plan: Multi-Node Network Mode

**Date**: 2026-03-23
**Topology**: MSM3U (serveur) ← MSM4M (client, machine courante)
**Branch**: `feat/multi-machine-network` on Regis-RCR/claude-mem
**Exécuté depuis**: MSM4M via SSH pour MSM3U

---

## Phase 0 : Sauvegarde et préparation (NON DESTRUCTIF)

### Principe

Aucune donnée existante ne doit être perdue. Chaque modification est réversible.

### 0.1 Backup sur MSM4M (local)

```bash
# Backup settings + DB + chroma
BACKUP_DIR=~/.claude-mem/backups/pre-multinode-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
cp ~/.claude-mem/settings.json "$BACKUP_DIR/"
cp ~/.claude-mem/claude-mem.db "$BACKUP_DIR/"
cp -r ~/.claude-mem/chroma/ "$BACKUP_DIR/chroma/" 2>/dev/null || true
echo "MSM4M backup: $BACKUP_DIR"
ls -la "$BACKUP_DIR"
```

### 0.2 Backup sur MSM3U (remote)

```bash
ssh MSM3U 'BACKUP_DIR=~/.claude-mem/backups/pre-multinode-$(date +%Y%m%d-%H%M%S) && mkdir -p "$BACKUP_DIR" && cp ~/.claude-mem/settings.json "$BACKUP_DIR/" && cp ~/.claude-mem/claude-mem.db "$BACKUP_DIR/" && cp -r ~/.claude-mem/chroma/ "$BACKUP_DIR/chroma/" 2>/dev/null; echo "MSM3U backup: $BACKUP_DIR" && ls -la "$BACKUP_DIR"'
```

### 0.3 Transférer la DB de MSM4M → MSM3U

MSM4M a la DB la plus récente (378MB vs 376MB). MSM3U sera le serveur, il doit avoir la meilleure DB.

```bash
# 1. Arrêter le worker sur MSM3U d'abord
ssh MSM3U "curl -s -X POST http://localhost:37777/api/admin/shutdown; sleep 2"

# 2. Copier la DB (via Thunderbolt — rapide)
scp ~/.claude-mem/claude-mem.db MSM3U:~/.claude-mem/claude-mem.db

# 3. Vérifier
ssh MSM3U "ls -la ~/.claude-mem/claude-mem.db"
```

### 0.4 Cloner/mettre à jour le fork sur MSM3U

```bash
ssh MSM3U 'cd ~/Development/GitHub/thedotmack 2>/dev/null || mkdir -p ~/Development/GitHub/thedotmack && cd ~/Development/GitHub/thedotmack && if [ -d claude-mem/.git ]; then cd claude-mem && git fetch origin && git checkout feat/multi-machine-network && git pull; else git clone -b feat/multi-machine-network git@github.com:Regis-RCR/claude-mem.git; fi && echo "=== Branch ===" && git branch && echo "=== Commit ===" && git log --oneline -1'
```

### 0.5 Build + sync sur MSM3U

```bash
ssh MSM3U 'cd ~/Development/GitHub/thedotmack/claude-mem && npm install && npm run build-and-sync'
```

### 0.6 Build + sync sur MSM4M (local)

```bash
cd /Users/regis/Development/GitHub/thedotmack/claude-mem && npm run build-and-sync
```

### 0.7 Arrêter les workers des deux côtés

```bash
# MSM4M
npm run worker:stop
# MSM3U
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:stop"
```

### Résultat attendu Phase 0

| Étape | Attendu | OK ? |
|-------|---------|------|
| 0.1 | Backup MSM4M créé | |
| 0.2 | Backup MSM3U créé | |
| 0.3 | DB MSM4M copiée sur MSM3U | |
| 0.4 | Fork cloné/à jour sur MSM3U | |
| 0.5 | Build OK sur MSM3U | |
| 0.6 | Build OK sur MSM4M | |
| 0.7 | Workers arrêtés des deux côtés | |

---

## Procédure de rollback (à utiliser si problème)

```bash
# Sur MSM4M
BACKUP=$(ls -td ~/.claude-mem/backups/pre-multinode-* | head -1)
npm run worker:stop
cp "$BACKUP/settings.json" ~/.claude-mem/settings.json
cp "$BACKUP/claude-mem.db" ~/.claude-mem/claude-mem.db
npm run worker:start

# Sur MSM3U
ssh MSM3U 'BACKUP=$(ls -td ~/.claude-mem/backups/pre-multinode-* | head -1) && cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:stop && cp "$BACKUP/settings.json" ~/.claude-mem/settings.json && cp "$BACKUP/claude-mem.db" ~/.claude-mem/claude-mem.db && npm run worker:start'
```

---

## Phase 1 : Smoke test standalone (aucun changement de config)

**But** : Vérifier que notre build ne casse rien en mode standalone.

```bash
# T1.1 — Worker MSM4M démarre avec le nouveau build
npm run worker:start && npm run worker:status

# T1.2 — Health check
curl -s http://localhost:37777/api/health | python3 -m json.tool

# T1.3 — Worker MSM3U démarre avec le nouveau build
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:start && curl -s http://localhost:37777/api/health | python3 -m json.tool"

# T1.4 — Les deux workers répondent mode=standalone
```

| Test | Attendu | OK ? |
|------|---------|------|
| T1.1 | Worker démarre sur MSM4M | |
| T1.2 | mode=standalone, node=macstudio-m4max-regis | |
| T1.3 | Worker démarre sur MSM3U | |
| T1.4 | mode=standalone sur les deux | |

---

## Phase 2 : MSM3U en mode serveur

```bash
# Arrêter le worker d'abord
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:stop"

# T2.1 — Configurer le mode serveur
ssh MSM3U "python3 -c \"
import json
with open('/Users/regis/.claude-mem/settings.json') as f: s = json.load(f)
s['CLAUDE_MEM_NETWORK_MODE'] = 'server'
with open('/Users/regis/.claude-mem/settings.json', 'w') as f: json.dump(s, f, indent=2)
print('Mode set to server')
\""

# T2.2 — Démarrer le worker (doit auto-générer token + changer bind)
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:start"

# T2.3 — Vérifier le token auto-généré
ssh MSM3U "python3 -c \"import json; s=json.load(open('/Users/regis/.claude-mem/settings.json')); print('Token:', s.get('CLAUDE_MEM_AUTH_TOKEN','MISSING')[:8]+'...'); print('Host:', s.get('CLAUDE_MEM_WORKER_HOST','MISSING')); print('Mode:', s.get('CLAUDE_MEM_NETWORK_MODE','MISSING'))\""

# T2.4 — Health check enrichi
ssh MSM3U "curl -s http://localhost:37777/api/health | python3 -m json.tool"

# T2.5 — Vérifier launchd
ssh MSM3U "ls ~/Library/LaunchAgents/com.claude-mem.worker.plist 2>/dev/null && echo 'Plist: OK' || echo 'Plist: MISSING'"
ssh MSM3U "launchctl list 2>/dev/null | grep claude-mem || echo 'Service: not loaded'"

# T2.6 — Accès distant avec token (depuis MSM4M)
TOKEN=$(ssh MSM3U "python3 -c \"import json; print(json.load(open('/Users/regis/.claude-mem/settings.json')).get('CLAUDE_MEM_AUTH_TOKEN',''))\"")
echo "Token récupéré: ${TOKEN:0:8}..."
curl -s -H "Authorization: Bearer $TOKEN" http://macstudio-m3ultra-regis:37777/api/health | python3 -m json.tool

# T2.7 — Accès SANS token (doit être rejeté)
curl -s http://macstudio-m3ultra-regis:37777/api/health

# T2.8 — Accès avec mauvais token
curl -s -H "Authorization: Bearer wrong" http://macstudio-m3ultra-regis:37777/api/health
```

| Test | Attendu | OK ? |
|------|---------|------|
| T2.1 | Mode = server dans settings | |
| T2.2 | Worker démarre | |
| T2.3 | Token auto-généré, Host=0.0.0.0 | |
| T2.4 | mode=server, connectedClients=0 | |
| T2.5 | Plist créé | |
| T2.6 | Health OK avec token | |
| T2.7 | 403 forbidden | |
| T2.8 | 401 unauthorized | |

---

## Phase 3 : MSM4M en mode client

```bash
# Arrêter le worker standalone local
npm run worker:stop

# T3.1 — Configurer le mode client
python3 -c "
import json
with open('/Users/regis/.claude-mem/settings.json') as f: s = json.load(f)
s['CLAUDE_MEM_NETWORK_MODE'] = 'client'
s['CLAUDE_MEM_SERVER_HOST'] = 'macstudio-m3ultra-regis'
s['CLAUDE_MEM_AUTH_TOKEN'] = '${TOKEN}'
with open('/Users/regis/.claude-mem/settings.json', 'w') as f: json.dump(s, f, indent=2)
print('Mode set to client, server =', s['CLAUDE_MEM_SERVER_HOST'])
"

# T3.2 — Démarrer le proxy
npm run worker:start && npm run worker:status

# T3.3 — Health check local (proxy)
curl -s http://localhost:37777/api/health | python3 -m json.tool

# T3.4 — Le proxy forward vers MSM3U
curl -s http://localhost:37777/api/clients | python3 -m json.tool

# T3.5 — Client visible côté serveur
ssh MSM3U "curl -s http://localhost:37777/api/clients | python3 -m json.tool"

# T3.6 — Envoyer une observation test via le proxy
curl -s -X POST http://localhost:37777/api/sessions/observations \
  -H "Content-Type: application/json" \
  -d '{"contentSessionId":"test-multinode-msm4m","tool_name":"Read","tool_input":"test.ts","tool_response":"hello from MSM4M","cwd":"/tmp"}' | python3 -m json.tool

# T3.7 — Vérifier que l'observation est sur MSM3U avec provenance
ssh MSM3U "curl -s 'http://localhost:37777/api/search?query=hello+from+MSM4M&limit=1' | python3 -m json.tool"
```

| Test | Attendu | OK ? |
|------|---------|------|
| T3.1 | Config client écrite | |
| T3.2 | Proxy démarre | |
| T3.3 | mode=client, proxy=true, serverReachable=true | |
| T3.4 | Forward OK, réponse du serveur | |
| T3.5 | macstudio-m4max-regis dans clients | |
| T3.6 | Observation acceptée (200 ou 201) | |
| T3.7 | Observation trouvée sur MSM3U avec node | |

---

## Phase 4 : Résilience offline

```bash
# T4.1 — Arrêter le serveur
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:stop"

# T4.2 — Health check proxy (serveur down)
curl -s http://localhost:37777/api/health | python3 -m json.tool

# T4.3 — Envoyer des observations (doivent être bufferisées)
curl -s -X POST http://localhost:37777/api/sessions/observations \
  -H "Content-Type: application/json" \
  -d '{"contentSessionId":"test-offline","tool_name":"Edit","tool_input":"offline.ts","tool_response":"buffered obs","cwd":"/tmp"}'
echo ""
curl -s -X POST http://localhost:37777/api/sessions/observations \
  -H "Content-Type: application/json" \
  -d '{"contentSessionId":"test-offline","tool_name":"Write","tool_input":"offline2.ts","tool_response":"buffered obs 2","cwd":"/tmp"}'

# T4.4 — Vérifier le buffer
echo "Buffer entries:" && cat ~/.claude-mem/buffer.jsonl 2>/dev/null | wc -l

# T4.5 — Redémarrer le serveur
ssh MSM3U "cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:start"

# T4.6 — Attendre le replay (health check toutes les 10s)
echo "Attente replay (20s)..." && sleep 20

# T4.7 — Buffer vidé ?
echo "Buffer entries après replay:" && cat ~/.claude-mem/buffer.jsonl 2>/dev/null | wc -l || echo "0 (fichier supprimé)"

# T4.8 — Observations arrivées sur MSM3U ?
ssh MSM3U "curl -s 'http://localhost:37777/api/search?query=buffered+obs&limit=2' | python3 -m json.tool"
```

| Test | Attendu | OK ? |
|------|---------|------|
| T4.1 | Serveur arrêté | |
| T4.2 | serverReachable=false | |
| T4.3 | 202 buffered | |
| T4.4 | >= 2 lignes dans buffer | |
| T4.5 | Serveur redémarré | |
| T4.6 | Replay déclenché | |
| T4.7 | Buffer vidé (0 lignes) | |
| T4.8 | Observations trouvées sur MSM3U | |

---

## Phase 5 : Provenance et viewer

```bash
# T5.1 — Observations avec provenance
ssh MSM3U "curl -s 'http://localhost:37777/api/observations?limit=5' | python3 -c \"
import sys,json
data = json.load(sys.stdin)
obs = data.get('observations', data if isinstance(data, list) else [])
for o in obs[:5]:
    print(f\\\"ID={o.get('id')} node={o.get('node')} platform={o.get('platform')}\\\")
\""

# T5.2 — Dashboard URL affichée lors du démarrage contexte
# (vérification manuelle au prochain démarrage de session Claude Code)
echo "Vérifier manuellement: la prochaine session CC doit afficher Mode: client → macstudio-m3ultra-regis"
```

| Test | Attendu | OK ? |
|------|---------|------|
| T5.1 | node renseigné sur observations récentes | |
| T5.2 | URL + status line (vérif manuelle) | |

---

## Phase 6 : Rollback vers standalone

```bash
# T6.1 — MSM4M retour standalone
npm run worker:stop
python3 -c "
import json
with open('/Users/regis/.claude-mem/settings.json') as f: s = json.load(f)
s['CLAUDE_MEM_NETWORK_MODE'] = 'standalone'
# Garder le token (pas de mal), supprimer SERVER_HOST
s.pop('CLAUDE_MEM_SERVER_HOST', None)
with open('/Users/regis/.claude-mem/settings.json', 'w') as f: json.dump(s, f, indent=2)
"
npm run worker:start
curl -s http://localhost:37777/api/health | python3 -m json.tool

# T6.2 — MSM3U retour standalone
ssh MSM3U "
cd ~/Development/GitHub/thedotmack/claude-mem && npm run worker:stop
python3 -c \"
import json
with open('/Users/regis/.claude-mem/settings.json') as f: s = json.load(f)
s['CLAUDE_MEM_NETWORK_MODE'] = 'standalone'
s['CLAUDE_MEM_WORKER_HOST'] = '127.0.0.1'
with open('/Users/regis/.claude-mem/settings.json', 'w') as f: json.dump(s, f, indent=2)
\"
npm run worker:start
curl -s http://localhost:37777/api/health | python3 -m json.tool
"

# T6.3 — Launchd déchargé sur MSM3U ?
ssh MSM3U "launchctl list 2>/dev/null | grep claude-mem || echo 'Service déchargé: OK'"
```

| Test | Attendu | OK ? |
|------|---------|------|
| T6.1 | MSM4M en standalone, worker OK | |
| T6.2 | MSM3U en standalone, worker OK | |
| T6.3 | Pas de service launchd | |

---

## Checklist finale

- [ ] Phase 0 : Backups + préparation
- [ ] Phase 1 : Smoke test standalone
- [ ] Phase 2 : Mode serveur MSM3U
- [ ] Phase 3 : Mode client MSM4M
- [ ] Phase 4 : Buffer offline + replay
- [ ] Phase 5 : Provenance
- [ ] Phase 6 : Rollback standalone
