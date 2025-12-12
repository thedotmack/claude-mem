🌐 Ceci est une traduction automatique. Les corrections de la communauté sont les bienvenues !

---
<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">Système de compression de mémoire persistante conçu pour <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#démarrage-rapide">Démarrage rapide</a> •
  <a href="#comment-ça-fonctionne">Comment ça fonctionne</a> •
  <a href="#outils-de-recherche-mcp">Outils de recherche</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#dépannage">Dépannage</a> •
  <a href="#licence">Licence</a>
</p>

<p align="center">
  Claude-Mem préserve de manière transparente le contexte entre les sessions en capturant automatiquement les observations d'utilisation des outils, en générant des résumés sémantiques et en les rendant disponibles pour les sessions futures. Cela permet à Claude de maintenir la continuité des connaissances sur les projets même après la fin ou la reconnexion des sessions.
</p>

---

## Démarrage rapide

Démarrez une nouvelle session Claude Code dans le terminal et entrez les commandes suivantes :

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Redémarrez Claude Code. Le contexte des sessions précédentes apparaîtra automatiquement dans les nouvelles sessions.

**Fonctionnalités clés :**

- 🧠 **Mémoire persistante** - Le contexte survit entre les sessions
- 📊 **Divulgation progressive** - Récupération de mémoire en couches avec visibilité du coût en tokens
- 🔍 **Recherche basée sur les compétences** - Interrogez votre historique de projet avec la compétence mem-search (économie de ~2 250 tokens)
- 🖥️ **Interface de visualisation web** - Flux de mémoire en temps réel sur http://localhost:37777
- 🔒 **Contrôle de la confidentialité** - Utilisez les balises `<private>` pour exclure le contenu sensible du stockage
- ⚙️ **Configuration du contexte** - Contrôle précis sur le contexte injecté
- 🤖 **Fonctionnement automatique** - Aucune intervention manuelle requise
- 🔗 **Citations** - Référencez les décisions passées avec les URI `claude-mem://`
- 🧪 **Canal bêta** - Essayez les fonctionnalités expérimentales comme le mode infini via le changement de version

---

## Documentation

📚 **[Voir la documentation complète](docs/)** - Parcourir les documents markdown sur GitHub

💻 **Aperçu local** : Exécutez les documents Mintlify localement :

```bash
cd docs
npx mintlify dev
```

### Pour commencer

- **[Guide d'installation](https://docs.claude-mem.ai/installation)** - Démarrage rapide et installation avancée
- **[Guide d'utilisation](https://docs.claude-mem.ai/usage/getting-started)** - Comment Claude-Mem fonctionne automatiquement
- **[Outils de recherche](https://docs.claude-mem.ai/usage/search-tools)** - Interrogez votre historique de projet en langage naturel
- **[Fonctionnalités bêta](https://docs.claude-mem.ai/beta-features)** - Essayez les fonctionnalités expérimentales comme le mode infini

### Meilleures pratiques

- **[Ingénierie du contexte](https://docs.claude-mem.ai/context-engineering)** - Principes d'optimisation du contexte des agents IA
- **[Divulgation progressive](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie derrière la stratégie d'amorçage du contexte de Claude-Mem

### Architecture

- **[Vue d'ensemble](https://docs.claude-mem.ai/architecture/overview)** - Composants du système et flux de données
- **[Évolution de l'architecture](https://docs.claude-mem.ai/architecture-evolution)** - Le parcours de v3 à v5
- **[Architecture des hooks](https://docs.claude-mem.ai/hooks-architecture)** - Comment Claude-Mem utilise les hooks de cycle de vie
- **[Référence des hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripts de hooks expliqués
- **[Service worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP et gestion PM2
- **[Base de données](https://docs.claude-mem.ai/architecture/database)** - Schéma SQLite et recherche FTS5
- **[Architecture de recherche](https://docs.claude-mem.ai/architecture/search-architecture)** - Recherche hybride avec base de données vectorielle Chroma

### Configuration et développement

- **[Configuration](https://docs.claude-mem.ai/configuration)** - Variables d'environnement et paramètres
- **[Développement](https://docs.claude-mem.ai/development)** - Compilation, tests, contribution
- **[Dépannage](https://docs.claude-mem.ai/troubleshooting)** - Problèmes courants et solutions

---

## Comment ça fonctionne

```
┌─────────────────────────────────────────────────────────────┐
│ Début de session → Injecter les observations récentes       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Prompts utilisateur → Créer une session, sauvegarder        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Exécutions d'outils → Capturer les observations             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Processus worker → Extraire les apprentissages via SDK      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Fin de session → Générer un résumé, prêt pour la suite      │
└─────────────────────────────────────────────────────────────┘
```

**Composants principaux :**

1. **5 hooks de cycle de vie** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Installation intelligente** - Vérificateur de dépendances en cache (script pré-hook, pas un hook de cycle de vie)
3. **Service worker** - API HTTP sur le port 37777 avec interface de visualisation web et 10 points de terminaison de recherche, géré par PM2
4. **Base de données SQLite** - Stocke les sessions, observations, résumés avec recherche en texte intégral FTS5
5. **Compétence mem-search** - Requêtes en langage naturel avec divulgation progressive (économie de ~2 250 tokens vs MCP)
6. **Base de données vectorielle Chroma** - Recherche hybride sémantique + mots-clés pour récupération intelligente du contexte

Voir [Vue d'ensemble de l'architecture](https://docs.claude-mem.ai/architecture/overview) pour plus de détails.

---

## Compétence mem-search

Claude-Mem fournit une recherche intelligente via la compétence mem-search qui s'invoque automatiquement lorsque vous posez des questions sur le travail passé :

**Comment ça fonctionne :**
- Posez simplement la question naturellement : *"Qu'avons-nous fait lors de la dernière session ?"* ou *"Avons-nous corrigé ce bug avant ?"*
- Claude invoque automatiquement la compétence mem-search pour trouver le contexte pertinent
- Économie de ~2 250 tokens par début de session vs l'approche MCP

**Opérations de recherche disponibles :**

1. **Recherche d'observations** - Recherche en texte intégral dans les observations
2. **Recherche de sessions** - Recherche en texte intégral dans les résumés de sessions
3. **Recherche de prompts** - Recherche dans les requêtes utilisateur brutes
4. **Par concept** - Recherche par balises de concepts (découverte, problème-solution, modèle, etc.)
5. **Par fichier** - Recherche d'observations référençant des fichiers spécifiques
6. **Par type** - Recherche par type (décision, correction de bug, fonctionnalité, refactorisation, découverte, changement)
7. **Contexte récent** - Obtenir le contexte de session récent pour un projet
8. **Chronologie** - Obtenir une chronologie unifiée du contexte autour d'un point spécifique dans le temps
9. **Chronologie par requête** - Rechercher des observations et obtenir le contexte chronologique autour de la meilleure correspondance
10. **Aide API** - Obtenir la documentation de l'API de recherche

**Exemples de requêtes en langage naturel :**

```
"Quels bugs avons-nous corrigés lors de la dernière session ?"
"Comment avons-nous implémenté l'authentification ?"
"Quels changements ont été apportés à worker-service.ts ?"
"Montrez-moi le travail récent sur ce projet"
"Que se passait-il quand nous avons ajouté l'interface de visualisation ?"
```

Voir [Guide des outils de recherche](https://docs.claude-mem.ai/usage/search-tools) pour des exemples détaillés.

---

## Fonctionnalités bêta et mode infini

Claude-Mem propose un **canal bêta** avec des fonctionnalités expérimentales. Basculez entre les versions stables et bêta directement depuis l'interface de visualisation web.

### Comment essayer la version bêta

1. Ouvrez http://localhost:37777
2. Cliquez sur Paramètres (icône d'engrenage)
3. Dans **Canal de version**, cliquez sur "Essayer la bêta (Mode infini)"
4. Attendez le redémarrage du worker

Vos données de mémoire sont préservées lors du changement de versions.

### Mode infini (Bêta)

La fonctionnalité phare de la bêta est le **Mode infini** - une architecture de mémoire biomimétique qui prolonge considérablement la durée de session :

**Le problème** : Les sessions Claude Code standard atteignent les limites de contexte après ~50 utilisations d'outils. Chaque outil ajoute 1 à 10k+ tokens, et Claude resynthétise toutes les sorties précédentes à chaque réponse (complexité O(N²)).

**La solution** : Le mode infini compresse les sorties d'outils en observations d'environ 500 tokens et transforme la transcription en temps réel :

```
Mémoire de travail (Contexte) :   Observations compressées (~500 tokens chacune)
Mémoire d'archive (Disque) :      Sorties complètes d'outils préservées pour rappel
```

**Résultats attendus** :
- Réduction d'environ 95% des tokens dans la fenêtre de contexte
- Environ 20x plus d'utilisations d'outils avant épuisement du contexte
- Mise à l'échelle linéaire O(N) au lieu de quadratique O(N²)
- Transcriptions complètes préservées pour un rappel parfait

**Mises en garde** : Ajoute de la latence (60-90s par outil pour la génération d'observation), encore expérimental.

Voir [Documentation des fonctionnalités bêta](https://docs.claude-mem.ai/beta-features) pour plus de détails.

---

## Nouveautés

**v6.4.9 - Paramètres de configuration du contexte :**
- 11 nouveaux paramètres pour un contrôle précis de l'injection de contexte
- Configurez l'affichage de l'économie de tokens, le filtrage des observations par type/concept
- Contrôlez le nombre d'observations et les champs à afficher

**v6.4.0 - Système de confidentialité à double balise :**
- Balises `<private>` pour la confidentialité contrôlée par l'utilisateur - enveloppez le contenu sensible pour l'exclure du stockage
- Balises système `<claude-mem-context>` empêchent le stockage récursif d'observations
- Traitement en périphérie garantit que le contenu privé n'atteint jamais la base de données

**v6.3.0 - Canal de version :**
- Basculez entre les versions stables et bêta depuis l'interface de visualisation web
- Essayez les fonctionnalités expérimentales comme le mode infini sans opérations git manuelles

**Points forts précédents :**
- **v6.0.0** : Améliorations majeures de la gestion de session et du traitement des transcriptions
- **v5.5.0** : Amélioration de la compétence mem-search avec un taux d'efficacité de 100%
- **v5.4.0** : Architecture de recherche basée sur les compétences (économie de ~2 250 tokens par session)
- **v5.1.0** : Interface de visualisation web avec mises à jour en temps réel
- **v5.0.0** : Recherche hybride avec base de données vectorielle Chroma

Voir [CHANGELOG.md](CHANGELOG.md) pour l'historique complet des versions.

---

## Exigences système

- **Node.js** : 18.0.0 ou supérieur
- **Claude Code** : Dernière version avec support des plugins
- **PM2** : Gestionnaire de processus (inclus - aucune installation globale requise)
- **SQLite 3** : Pour le stockage persistant (inclus)

---

## Avantages clés

### Contexte de divulgation progressive

- **Récupération de mémoire en couches** reflète les modèles de mémoire humaine
- **Couche 1 (Index)** : Voir quelles observations existent avec les coûts en tokens au début de session
- **Couche 2 (Détails)** : Récupérer les récits complets à la demande via recherche MCP
- **Couche 3 (Rappel parfait)** : Accéder au code source et aux transcriptions originales
- **Prise de décision intelligente** : Les comptes de tokens aident Claude à choisir entre récupérer des détails ou lire du code
- **Indicateurs de type** : Repères visuels (🔴 critique, 🟤 décision, 🔵 informationnel) mettent en évidence l'importance de l'observation

### Mémoire automatique

- Contexte automatiquement injecté au démarrage de Claude
- Aucune commande manuelle ou configuration nécessaire
- Fonctionne de manière transparente en arrière-plan

### Recherche dans l'historique complet

- Recherche dans toutes les sessions et observations
- Recherche en texte intégral FTS5 pour des requêtes rapides
- Les citations renvoient à des observations spécifiques

### Observations structurées

- Extraction des apprentissages assistée par IA
- Catégorisées par type (décision, correction de bug, fonctionnalité, etc.)
- Étiquetées avec des concepts et des références de fichiers

### Sessions multi-prompts

- Les sessions couvrent plusieurs prompts utilisateur
- Contexte préservé à travers les commandes `/clear`
- Suivi de threads de conversation entiers

---

## Configuration

Les paramètres sont gérés dans `~/.claude-mem/settings.json`. Le fichier est créé automatiquement avec les valeurs par défaut lors de la première exécution.

**Paramètres disponibles :**

| Paramètre | Défaut | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Modèle IA pour les observations |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Port du service worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Emplacement du répertoire de données |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Niveau de détail des logs (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Version Python pour chroma-mcp |
| `CLAUDE_CODE_PATH` | _(détection auto)_ | Chemin vers l'exécutable Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Nombre d'observations à injecter au SessionStart |

**Gestion des paramètres :**

```bash
# Modifier les paramètres via l'assistant CLI
./claude-mem-settings.sh

# Ou modifier directement
nano ~/.claude-mem/settings.json

# Voir les paramètres actuels
curl http://localhost:37777/api/settings
```

**Format du fichier de paramètres :**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Voir [Guide de configuration](https://docs.claude-mem.ai/configuration) pour plus de détails.

---

## Développement

```bash
# Cloner et compiler
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Exécuter les tests
npm test

# Démarrer le worker
npm run worker:start

# Voir les logs
npm run worker:logs
```

Voir [Guide de développement](https://docs.claude-mem.ai/development) pour des instructions détaillées.

---

## Dépannage

**Diagnostic rapide :**

Si vous rencontrez des problèmes, décrivez le problème à Claude et la compétence de dépannage s'activera automatiquement pour diagnostiquer et fournir des corrections.

**Problèmes courants :**

- Worker ne démarre pas → `npm run worker:restart`
- Aucun contexte n'apparaît → `npm run test:context`
- Problèmes de base de données → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Recherche ne fonctionne pas → Vérifiez que les tables FTS5 existent

Voir [Guide de dépannage](https://docs.claude-mem.ai/troubleshooting) pour des solutions complètes.

---

## Contribuer

Les contributions sont les bienvenues ! Veuillez :

1. Forker le dépôt
2. Créer une branche de fonctionnalité
3. Apporter vos modifications avec des tests
4. Mettre à jour la documentation
5. Soumettre une Pull Request

Voir [Guide de développement](https://docs.claude-mem.ai/development) pour le flux de travail de contribution.

---

## Licence

Ce projet est sous licence **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Tous droits réservés.

Voir le fichier [LICENSE](LICENSE) pour les détails complets.

**Ce que cela signifie :**

- Vous pouvez utiliser, modifier et distribuer ce logiciel librement
- Si vous modifiez et déployez sur un serveur réseau, vous devez rendre votre code source disponible
- Les œuvres dérivées doivent également être sous licence AGPL-3.0
- Il n'y a AUCUNE GARANTIE pour ce logiciel

---

## Support

- **Documentation** : [docs/](docs/)
- **Problèmes** : [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Dépôt** : [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Auteur** : Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construit avec Claude Agent SDK** | **Propulsé par Claude Code** | **Fait avec TypeScript**