🌐 Ceci est une traduction maintenue par la communauté. Les corrections sont les bienvenues !

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

**Languages:** [English](../../README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Português](./README.pt-br.md) · [Русский](./README.ru.md) · [Deutsch](./README.de.md)

<h4 align="center">Système de compression de mémoire persistante conçu pour <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
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

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg" alt="thedotmack/claude-mem | Trendshift" width="250" height="55"/>
    </picture>
  </a>
</p>

<br>

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/thedotmack/claude-mem">
        <picture>
          <img
            src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif"
            alt="Claude-Mem Preview"
            width="500"
          >
        </picture>
      </a>
    </td>
    <td align="center">
      <a href="https://www.star-history.com/#thedotmack/claude-mem&Date">
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&theme=dark&legend=top-left"
          />
          <source
            media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
          />
          <img
            alt="Star History Chart"
            src="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
            width="500"
          />
        </picture>
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <a href="#quick-start">Démarrage rapide</a> •
  <a href="#how-it-works">Fonctionnement</a> •
  <a href="#mcp-search-tools">Outils de recherche</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Dépannage</a> •
  <a href="#license">Licence</a>
</p>

<p align="center">
  Claude-Mem préserve sans effort le contexte entre les sessions en capturant automatiquement les observations d'utilisation des outils, en générant des résumés sémantiques et en les mettant à disposition des sessions futures. Claude peut ainsi maintenir la continuité des connaissances sur les projets même après la fin ou la reconnexion des sessions.
</p>

---

## Démarrage rapide

Installez en une seule commande :

```bash
npx claude-mem install
```

Ou installez pour Gemini CLI (détecte automatiquement `~/.gemini`) :

```bash
npx claude-mem install --ide gemini-cli
```
Ou installez pour OpenCode :

```bash
npx claude-mem install --ide opencode
```

Ou installez depuis la marketplace de plugins dans Claude Code :

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

Redémarrez Claude Code ou Gemini CLI. Le contexte des sessions précédentes apparaîtra automatiquement dans les nouvelles sessions.

> **Remarque :** Claude-Mem est également publié sur npm, mais `npm install -g claude-mem` installe **uniquement le SDK/la bibliothèque** — il n'enregistre pas les hooks du plugin ni ne configure le service worker. Installez toujours via `npx claude-mem install` ou les commandes `/plugin` ci-dessus.

### 🦞 OpenClaw Gateway

Installez claude-mem comme plugin de mémoire persistante sur les gateways [OpenClaw](https://openclaw.ai) en une seule commande :

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

L'installateur gère les dépendances, la configuration du plugin, le fournisseur d'IA, le démarrage du worker et les flux d'observation en temps réel optionnels vers Telegram, Discord, Slack et plus. Consultez le [Guide d'intégration OpenClaw](https://docs.claude-mem.ai/openclaw-integration) pour plus de détails.

**Fonctionnalités clés :**

- 🧠 **Mémoire persistante** - Le contexte survit d'une session à l'autre
- 📊 **Divulgation progressive** - Récupération de mémoire par couches avec visibilité du coût en tokens
- 🔍 **Recherche basée sur les skills** - Interrogez l'historique du projet avec la skill mem-search
- 🖥️ **Interface web** - Flux de mémoire en temps réel sur http://localhost:37777
- 💻 **Skill Claude Desktop** - Recherchez dans la mémoire depuis les conversations Claude Desktop
- 🔒 **Contrôle de la confidentialité** - Utilisez les balises `<private>` pour exclure le contenu sensible du stockage
- ⚙️ **Configuration du contexte** - Contrôle fin de ce qui est injecté comme contexte
- 🤖 **Fonctionnement automatique** - Aucune intervention manuelle requise
- 🔗 **Citations** - Référencez les observations passées par ID (accès via http://localhost:37777/api/observation/{id} ou consultez-les toutes dans l'interface web sur http://localhost:37777)
- 🧪 **Canal bêta** - Essayez des fonctionnalités expérimentales comme Endless Mode en changeant de version

---

## Documentation

📚 **[Voir la documentation complète](https://docs.claude-mem.ai/)** - Parcourez le site officiel

### Premiers pas

- **[Guide d'installation](https://docs.claude-mem.ai/installation)** - Démarrage rapide et installation avancée
- **[Configuration Gemini CLI](https://docs.claude-mem.ai/gemini-cli/setup)** - Guide dédié à l'intégration avec Gemini CLI de Google
- **[Guide d'utilisation](https://docs.claude-mem.ai/usage/getting-started)** - Comment Claude-Mem fonctionne automatiquement
- **[Outils de recherche](https://docs.claude-mem.ai/usage/search-tools)** - Interrogez l'historique du projet en langage naturel
- **[Fonctionnalités bêta](https://docs.claude-mem.ai/beta-features)** - Essayez des fonctionnalités expérimentales comme Endless Mode

### Bonnes pratiques

- **[Ingénierie du contexte](https://docs.claude-mem.ai/context-engineering)** - Principes d'optimisation du contexte des agents IA
- **[Divulgation progressive](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie derrière la stratégie de préparation du contexte de Claude-Mem

### Architecture

- **[Vue d'ensemble](https://docs.claude-mem.ai/architecture/overview)** - Composants du système et flux de données
- **[Évolution de l'architecture](https://docs.claude-mem.ai/architecture-evolution)** - Le parcours de v3 à v5
- **[Architecture des hooks](https://docs.claude-mem.ai/hooks-architecture)** - Comment Claude-Mem utilise les hooks du cycle de vie
- **[Référence des hooks](https://docs.claude-mem.ai/architecture/hooks)** - Explication des 7 scripts de hooks
- **[Service worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP et gestion par Bun
- **[Base de données](https://docs.claude-mem.ai/architecture/database)** - Schéma SQLite et recherche FTS5
- **[Architecture de recherche](https://docs.claude-mem.ai/architecture/search-architecture)** - Recherche hybride avec base de données vectorielle Chroma

### Configuration et développement

- **[Configuration](https://docs.claude-mem.ai/configuration)** - Variables d'environnement et paramètres
- **[Développement](https://docs.claude-mem.ai/development)** - Compilation, tests et contribution
- **[Dépannage](https://docs.claude-mem.ai/troubleshooting)** - Problèmes courants et solutions

---

## Fonctionnement

**Composants principaux :**

1. **5 hooks du cycle de vie** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Smart Install** - Vérificateur de dépendances en cache (script pre-hook, pas un hook du cycle de vie)
3. **Service worker** - API HTTP sur le port 37777 avec interface web et 10 points de terminaison de recherche, géré par Bun
4. **Base de données SQLite** - Stocke les sessions, observations et résumés
5. **Skill mem-search** - Requêtes en langage naturel avec divulgation progressive
6. **Base de données vectorielle Chroma** - Recherche hybride sémantique + mots-clés pour une récupération intelligente du contexte

Consultez la [Vue d'ensemble de l'architecture](https://docs.claude-mem.ai/architecture/overview) pour plus de détails.

---

## Outils de recherche MCP

Claude-Mem offre une recherche intelligente de la mémoire via **4 outils MCP** suivant un **modèle de flux de travail en 3 couches** économe en tokens :

**Flux de travail en 3 couches :**

1. **`search`** - Obtenez un index compact avec IDs (~50-100 tokens/résultat)
2. **`timeline`** - Obtenez le contexte chronologique autour des résultats intéressants
3. **`get_observations`** - Récupérez les détails complets UNIQUEMENT pour les IDs filtrés (~500-1 000 tokens/résultat)

**Fonctionnement :**
- Claude utilise les outils MCP pour rechercher dans votre mémoire
- Commencez par `search` pour obtenir un index de résultats
- Utilisez `timeline` pour voir ce qui se passait autour d'observations spécifiques
- Utilisez `get_observations` pour récupérer les détails complets des IDs pertinents
- **~10x d'économie de tokens** en filtrant avant de récupérer les détails

**Outils MCP disponibles :**

1. **`search`** - Recherchez dans l'index de mémoire avec des requêtes en texte intégral, filtres par type/date/projet
2. **`timeline`** - Obtenez le contexte chronologique autour d'une observation ou requête spécifique
3. **`get_observations`** - Récupérez les détails complets des observations par IDs (regroupez toujours plusieurs IDs)

**Exemple d'utilisation :**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

Consultez le [Guide des outils de recherche](https://docs.claude-mem.ai/usage/search-tools) pour des exemples détaillés.

---

## Fonctionnalités bêta

Claude-Mem propose un **canal bêta** avec des fonctionnalités expérimentales comme **Endless Mode** (architecture de mémoire biomimétique pour les sessions prolongées). Basculez entre les versions stable et bêta depuis l'interface web sur http://localhost:37777 → Settings.

Consultez la **[Documentation des fonctionnalités bêta](https://docs.claude-mem.ai/beta-features)** pour les détails sur Endless Mode et comment l'essayer.

---

## Configuration requise

- **Node.js** : 18.0.0 ou supérieur
- **Claude Code** : Dernière version avec prise en charge des plugins
- **Bun** : Runtime JavaScript et gestionnaire de processus (installé automatiquement si absent)
- **uv** : Gestionnaire de paquets Python pour la recherche vectorielle (installé automatiquement si absent)
- **SQLite 3** : Pour le stockage persistant (inclus)

---
### Notes d'installation sous Windows

Si vous voyez une erreur du type :

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Assurez-vous que Node.js et npm sont installés et ajoutés à votre PATH. Téléchargez le dernier installateur Node.js sur https://nodejs.org et redémarrez votre terminal après l'installation.

---

## Configuration

Les paramètres sont gérés dans `~/.claude-mem/settings.json` (créé automatiquement avec les valeurs par défaut au premier lancement). Configurez le modèle d'IA, le port du worker, le répertoire de données, le niveau de journalisation et les paramètres d'injection de contexte.

Consultez le **[Guide de configuration](https://docs.claude-mem.ai/configuration)** pour tous les paramètres disponibles et des exemples.

### Configuration du mode et de la langue

Claude-Mem prend en charge plusieurs modes de flux de travail et langues via le paramètre `CLAUDE_MEM_MODE`.

Cette option contrôle à la fois :
- Le comportement du flux de travail (p. ex. code, chill, investigation)
- La langue utilisée dans les observations générées

#### Comment configurer

Modifiez votre fichier de paramètres dans `~/.claude-mem/settings.json` :

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

Les modes sont définis dans `plugin/modes/`. Pour voir tous les modes disponibles localement :

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### Modes disponibles

| Mode | Description |
|------------|-------------------------|
| `code` | Mode anglais par défaut |
| `code--zh` | Mode chinois simplifié |
| `code--ja` | Mode japonais |

Les modes spécifiques à une langue suivent le modèle `code--[lang]`, où `[lang]` est le code de langue ISO 639-1 (p. ex., `zh` pour le chinois, `ja` pour le japonais, `es` pour l'espagnol).

> Remarque : `code--zh` (chinois simplifié) est déjà intégré — aucune installation supplémentaire ni mise à jour du plugin n'est requise.

#### Après changement de mode

Redémarrez Claude Code pour appliquer la nouvelle configuration de mode.
---

## Développement

Consultez le **[Guide de développement](https://docs.claude-mem.ai/development)** pour les instructions de compilation, de test et le flux de contribution.

---

## Dépannage

En cas de problème, décrivez-le à Claude et la skill troubleshoot diagnostiquera automatiquement et proposera des corrections.

Consultez le **[Guide de dépannage](https://docs.claude-mem.ai/troubleshooting)** pour les problèmes courants et leurs solutions.

---

## Rapports de bugs

Créez des rapports de bugs complets avec le générateur automatisé :

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuer

Les contributions sont les bienvenues ! Veuillez :

1. Forker le dépôt
2. Créer une branche de fonctionnalité
3. Apporter vos modifications avec des tests
4. Mettre à jour la documentation
5. Soumettre une Pull Request

Consultez le [Guide de développement](https://docs.claude-mem.ai/development) pour le flux de contribution.

---

## Licence

Claude-Mem est sous licence Apache License 2.0.

Nous avons choisi Apache-2.0 parce que la mémoire persistante des agents doit être facile à intégrer dans
les outils de développement, les agents locaux, les serveurs MCP, les systèmes d'entreprise, les stacks robotiques,
et les frameworks d'agents en production.

Consultez le fichier [LICENSE](LICENSE) pour tous les détails. Consultez [docs/license.md](docs/license.md)
et [docs/ip-boundary.md](docs/ip-boundary.md) pour la portée de la licence et la
frontière open/commerciale.

**Note sur Ragtime** : Le répertoire `ragtime/` est sous licence **Apache License 2.0**. Consultez [ragtime/LICENSE](ragtime/LICENSE) pour plus de détails.

---

## Support

- **Documentation** : [docs/](docs/)
- **Problèmes** : [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Dépôt** : [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Compte X officiel** : [@Claude_Memory](https://x.com/Claude_Memory)
- **Discord officiel** : [Rejoindre Discord](https://discord.com/invite/J4wttp9vDu)
- **Auteur** : Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construit avec Claude Agent SDK** | **Compatible avec Claude Code** | **Fait avec TypeScript**

---

### Et $CMEM ?

$CMEM est un token Solana créé par un tiers sans le consentement préalable de Claude-Mem, mais officiellement adopté par le créateur de Claude-Mem (Alex Newman, @thedotmack). Le token sert de catalyseur communautaire pour la croissance et de vecteur pour apporter des données d'agents en temps réel aux développeurs et travailleurs du savoir qui en ont le plus besoin. $CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
