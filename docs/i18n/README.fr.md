🌐 Ceci est une traduction automatisée. Les corrections de la communauté sont les bienvenues !

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

<p align="center">
  <a href="README.zh.md">🇨🇳 中文</a> •
  <a href="README.zh-tw.md">🇹🇼 繁體中文</a> •
  <a href="README.ja.md">🇯🇵 日本語</a> •
  <a href="README.pt-br.md">🇧🇷 Português</a> •
  <a href="README.ko.md">🇰🇷 한국어</a> •
  <a href="README.es.md">🇪🇸 Español</a> •
  <a href="README.de.md">🇩🇪 Deutsch</a> •
  <a href="README.fr.md">🇫🇷 Français</a>
  <a href="README.he.md">🇮🇱 עברית</a> •
  <a href="README.ar.md">🇸🇦 العربية</a> •
  <a href="README.ru.md">🇷🇺 Русский</a> •
  <a href="README.pl.md">🇵🇱 Polski</a> •
  <a href="README.cs.md">🇨🇿 Čeština</a> •
  <a href="README.nl.md">🇳🇱 Nederlands</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.uk.md">🇺🇦 Українська</a> •
  <a href="README.vi.md">🇻🇳 Tiếng Việt</a> •
  <a href="README.id.md">🇮🇩 Indonesia</a> •
  <a href="README.th.md">🇹🇭 ไทย</a> •
  <a href="README.hi.md">🇮🇳 हिन्दी</a> •
  <a href="README.bn.md">🇧🇩 বাংলা</a> •
  <a href="README.ur.md">🇵🇰 اردو</a> •
  <a href="README.ro.md">🇷🇴 Română</a> •
  <a href="README.sv.md">🇸🇪 Svenska</a> •
  <a href="README.it.md">🇮🇹 Italiano</a> •
  <a href="README.el.md">🇬🇷 Ελληνικά</a> •
  <a href="README.hu.md">🇭🇺 Magyar</a> •
  <a href="README.fi.md">🇫🇮 Suomi</a> •
  <a href="README.da.md">🇩🇰 Dansk</a> •
  <a href="README.no.md">🇳🇴 Norsk</a>
</p>

<h4 align="center">Système de compression de mémoire persistante conçu pour <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License">
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
  <a href="#compétence-mem-search">Outils de recherche</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#dépannage">Dépannage</a> •
  <a href="#licence">Licence</a>
</p>

<p align="center">
  Claude-Mem préserve de manière transparente le contexte d'une session à l'autre en capturant automatiquement les observations d'utilisation des outils, en générant des résumés sémantiques et en les rendant disponibles pour les sessions futures. Cela permet à Claude de maintenir la continuité des connaissances sur les projets même après la fin des sessions ou la reconnexion.
</p>

---

## Démarrage rapide

Démarrez une nouvelle session Claude Code dans le terminal et saisissez les commandes suivantes :

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Redémarrez Claude Code. Le contexte des sessions précédentes apparaîtra automatiquement dans les nouvelles sessions.

**Fonctionnalités clés :**

- 🧠 **Mémoire persistante** - Le contexte survit d'une session à l'autre
- 📊 **Divulgation progressive** - Récupération de mémoire en couches avec visibilité du coût en tokens
- 🔍 **Recherche basée sur les compétences** - Interrogez l'historique de votre projet avec la compétence mem-search
- 🖥️ **Interface Web de visualisation** - Flux de mémoire en temps réel à http://localhost:37777
- 💻 **Compétence Claude Desktop** - Recherchez dans la mémoire depuis les conversations Claude Desktop
- 🔒 **Contrôle de la confidentialité** - Utilisez les balises `<private>` pour exclure le contenu sensible du stockage
- ⚙️ **Configuration du contexte** - Contrôle précis sur le contexte injecté
- 🤖 **Fonctionnement automatique** - Aucune intervention manuelle requise
- 🔗 **Citations** - Référencez les observations passées avec des ID (accès via http://localhost:37777/api/observation/{id} ou visualisez tout dans l'interface web à http://localhost:37777)
- 🧪 **Canal bêta** - Essayez des fonctionnalités expérimentales comme le mode Endless via le changement de version

---

## Documentation

📚 **[Voir la documentation complète](https://docs.claude-mem.ai/)** - Parcourir sur le site officiel

### Pour commencer

- **[Guide d'installation](https://docs.claude-mem.ai/installation)** - Démarrage rapide et installation avancée
- **[Guide d'utilisation](https://docs.claude-mem.ai/usage/getting-started)** - Comment Claude-Mem fonctionne automatiquement
- **[Outils de recherche](https://docs.claude-mem.ai/usage/search-tools)** - Interrogez l'historique de votre projet en langage naturel
- **[Fonctionnalités bêta](https://docs.claude-mem.ai/beta-features)** - Essayez des fonctionnalités expérimentales comme le mode Endless

### Bonnes pratiques

- **[Ingénierie du contexte](https://docs.claude-mem.ai/context-engineering)** - Principes d'optimisation du contexte pour les agents IA
- **[Divulgation progressive](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophie derrière la stratégie d'amorçage du contexte de Claude-Mem

### Architecture

- **[Vue d'ensemble](https://docs.claude-mem.ai/architecture/overview)** - Composants du système et flux de données
- **[Évolution de l'architecture](https://docs.claude-mem.ai/architecture-evolution)** - Le parcours de la v3 à la v5
- **[Architecture des hooks](https://docs.claude-mem.ai/hooks-architecture)** - Comment Claude-Mem utilise les hooks de cycle de vie
- **[Référence des hooks](https://docs.claude-mem.ai/architecture/hooks)** - Explication des 7 scripts de hooks
- **[Service Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP et gestion Bun
- **[Base de données](https://docs.claude-mem.ai/architecture/database)** - Schéma SQLite et recherche FTS5
- **[Architecture de recherche](https://docs.claude-mem.ai/architecture/search-architecture)** - Recherche hybride avec la base de données vectorielle Chroma

### Configuration et développement

- **[Configuration](https://docs.claude-mem.ai/configuration)** - Variables d'environnement et paramètres
- **[Développement](https://docs.claude-mem.ai/development)** - Compilation, tests, contribution
- **[Dépannage](https://docs.claude-mem.ai/troubleshooting)** - Problèmes courants et solutions

---

## Comment ça fonctionne

**Composants principaux :**

1. **5 hooks de cycle de vie** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Installation intelligente** - Vérificateur de dépendances en cache (script pré-hook, pas un hook de cycle de vie)
3. **Service Worker** - API HTTP sur le port 37777 avec interface web de visualisation et 10 points de terminaison de recherche, géré par Bun
4. **Base de données SQLite** - Stocke les sessions, observations, résumés
5. **Compétence mem-search** - Requêtes en langage naturel avec divulgation progressive
6. **Base de données vectorielle Chroma** - Recherche hybride sémantique + mots-clés pour une récupération de contexte intelligente

Voir [Vue d'ensemble de l'architecture](https://docs.claude-mem.ai/architecture/overview) pour plus de détails.

---

## Compétence mem-search

Claude-Mem fournit une recherche intelligente via la compétence mem-search qui s'invoque automatiquement lorsque vous posez des questions sur le travail passé :

**Comment ça fonctionne :**
- Posez simplement des questions naturellement : *"Qu'avons-nous fait lors de la dernière session ?"* ou *"Avons-nous déjà corrigé ce bug ?"*
- Claude invoque automatiquement la compétence mem-search pour trouver le contexte pertinent

**Opérations de recherche disponibles :**

1. **Rechercher des observations** - Recherche plein texte dans les observations
2. **Rechercher des sessions** - Recherche plein texte dans les résumés de sessions
3. **Rechercher des invites** - Rechercher dans les demandes brutes des utilisateurs
4. **Par concept** - Trouver par étiquettes de concept (discovery, problem-solution, pattern, etc.)
5. **Par fichier** - Trouver les observations faisant référence à des fichiers spécifiques
6. **Par type** - Trouver par type (decision, bugfix, feature, refactor, discovery, change)
7. **Contexte récent** - Obtenir le contexte récent d'une session pour un projet
8. **Timeline** - Obtenir une chronologie unifiée du contexte autour d'un point spécifique dans le temps
9. **Timeline par requête** - Rechercher des observations et obtenir le contexte de la chronologie autour de la meilleure correspondance
10. **Aide API** - Obtenir la documentation de l'API de recherche

**Exemples de requêtes en langage naturel :**

```
"Quels bugs avons-nous corrigés lors de la dernière session ?"
"Comment avons-nous implémenté l'authentification ?"
"Quels changements ont été apportés à worker-service.ts ?"
"Montrez-moi le travail récent sur ce projet"
"Que se passait-il lorsque nous avons ajouté l'interface de visualisation ?"
```

Voir le [Guide des outils de recherche](https://docs.claude-mem.ai/usage/search-tools) pour des exemples détaillés.

---

## Fonctionnalités bêta

Claude-Mem propose un **canal bêta** avec des fonctionnalités expérimentales comme le **mode Endless** (architecture de mémoire biomimétique pour les sessions étendues). Basculez entre les versions stables et bêta depuis l'interface web de visualisation à http://localhost:37777 → Paramètres.

Voir la **[Documentation des fonctionnalités bêta](https://docs.claude-mem.ai/beta-features)** pour plus de détails sur le mode Endless et comment l'essayer.

---

## Configuration système requise

- **Node.js** : 18.0.0 ou supérieur
- **Claude Code** : Dernière version avec support des plugins
- **Bun** : Runtime JavaScript et gestionnaire de processus (installé automatiquement si manquant)
- **uv** : Gestionnaire de packages Python pour la recherche vectorielle (installé automatiquement si manquant)
- **SQLite 3** : Pour le stockage persistant (inclus)

---

## Configuration

Les paramètres sont gérés dans `~/.claude-mem/settings.json` (créé automatiquement avec les valeurs par défaut au premier lancement). Configurez le modèle IA, le port du worker, le répertoire de données, le niveau de journalisation et les paramètres d'injection de contexte.

Voir le **[Guide de configuration](https://docs.claude-mem.ai/configuration)** pour tous les paramètres disponibles et des exemples.

---

## Développement

Voir le **[Guide de développement](https://docs.claude-mem.ai/development)** pour les instructions de compilation, les tests et le flux de contribution.

---

## Dépannage

Si vous rencontrez des problèmes, décrivez le problème à Claude et la compétence troubleshoot diagnostiquera automatiquement et fournira des solutions.

Voir le **[Guide de dépannage](https://docs.claude-mem.ai/troubleshooting)** pour les problèmes courants et les solutions.

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
3. Effectuer vos modifications avec des tests
4. Mettre à jour la documentation
5. Soumettre une Pull Request

Voir le [Guide de développement](https://docs.claude-mem.ai/development) pour le flux de contribution.

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## Support

- **Documentation** : [docs/](docs/)
- **Issues** : [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Dépôt** : [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Auteur** : Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construit avec Claude Agent SDK** | **Propulsé par Claude Code** | **Fait avec TypeScript**

---