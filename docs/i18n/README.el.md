🌐 Αυτή είναι μια αυτοματοποιημένη μετάφραση. Καλώς ορίζονται οι διορθώσεις από την κοινότητα!

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

<h4 align="center">Σύστημα συμπίεσης μόνιμης μνήμης κατασκευασμένο για το <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#γρήγορη-εκκίνηση">Γρήγορη Εκκίνηση</a> •
  <a href="#πώς-λειτουργεί">Πώς Λειτουργεί</a> •
  <a href="#εργαλεία-αναζήτησης-mcp">Εργαλεία Αναζήτησης</a> •
  <a href="#τεκμηρίωση">Τεκμηρίωση</a> •
  <a href="#διαμόρφωση">Διαμόρφωση</a> •
  <a href="#αντιμετώπιση-προβλημάτων">Αντιμετώπιση Προβλημάτων</a> •
  <a href="#άδεια-χρήσης">Άδεια Χρήσης</a>
</p>

<p align="center">
  Το Claude-Mem διατηρεί απρόσκοπτα το πλαίσιο μεταξύ συνεδριών καταγράφοντας αυτόματα παρατηρήσεις χρήσης εργαλείων, δημιουργώντας σημασιολογικές περιλήψεις και καθιστώντας τες διαθέσιμες σε μελλοντικές συνεδρίες. Αυτό επιτρέπει στο Claude να διατηρεί τη συνέχεια της γνώσης για έργα ακόμη και μετά το τέλος ή την επανασύνδεση συνεδριών.
</p>

---

## Γρήγορη Εκκίνηση

Ξεκινήστε μια νέα συνεδρία Claude Code στο τερματικό και εισάγετε τις ακόλουθες εντολές:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Επανεκκινήστε το Claude Code. Το πλαίσιο από προηγούμενες συνεδρίες θα εμφανιστεί αυτόματα σε νέες συνεδρίες.

**Βασικά Χαρακτηριστικά:**

- 🧠 **Μόνιμη Μνήμη** - Το πλαίσιο διατηρείται μεταξύ συνεδριών
- 📊 **Προοδευτική Αποκάλυψη** - Ανάκτηση μνήμης σε επίπεδα με ορατότητα κόστους tokens
- 🔍 **Αναζήτηση Βασισμένη σε Δεξιότητες** - Ερωτήματα στο ιστορικό του έργου σας με τη δεξιότητα mem-search
- 🖥️ **Διεπαφή Web Viewer** - Ροή μνήμης σε πραγματικό χρόνο στο http://localhost:37777
- 💻 **Δεξιότητα Claude Desktop** - Αναζήτηση μνήμης από συνομιλίες Claude Desktop
- 🔒 **Έλεγχος Απορρήτου** - Χρησιμοποιήστε ετικέτες `<private>` για να εξαιρέσετε ευαίσθητο περιεχόμενο από την αποθήκευση
- ⚙️ **Διαμόρφωση Πλαισίου** - Λεπτομερής έλεγχος για το ποιο πλαίσιο εισάγεται
- 🤖 **Αυτόματη Λειτουργία** - Δεν απαιτείται χειροκίνητη παρέμβαση
- 🔗 **Αναφορές** - Αναφορά σε παλαιότερες παρατηρήσεις με IDs (πρόσβαση μέσω http://localhost:37777/api/observation/{id} ή προβολή όλων στο web viewer στο http://localhost:37777)
- 🧪 **Κανάλι Beta** - Δοκιμάστε πειραματικά χαρακτηριστικά όπως το Endless Mode μέσω εναλλαγής έκδοσης

---

## Τεκμηρίωση

📚 **[Προβολή Πλήρους Τεκμηρίωσης](https://docs.claude-mem.ai/)** - Περιήγηση στον επίσημο ιστότοπο

### Ξεκινώντας

- **[Οδηγός Εγκατάστασης](https://docs.claude-mem.ai/installation)** - Γρήγορη εκκίνηση & προηγμένη εγκατάσταση
- **[Οδηγός Χρήσης](https://docs.claude-mem.ai/usage/getting-started)** - Πώς λειτουργεί αυτόματα το Claude-Mem
- **[Εργαλεία Αναζήτησης](https://docs.claude-mem.ai/usage/search-tools)** - Ερωτήματα στο ιστορικό του έργου σας με φυσική γλώσσα
- **[Χαρακτηριστικά Beta](https://docs.claude-mem.ai/beta-features)** - Δοκιμάστε πειραματικά χαρακτηριστικά όπως το Endless Mode

### Βέλτιστες Πρακτικές

- **[Μηχανική Πλαισίου](https://docs.claude-mem.ai/context-engineering)** - Αρχές βελτιστοποίησης πλαισίου για AI agents
- **[Προοδευτική Αποκάλυψη](https://docs.claude-mem.ai/progressive-disclosure)** - Φιλοσοφία πίσω από τη στρατηγική προετοιμασίας πλαισίου του Claude-Mem

### Αρχιτεκτονική

- **[Επισκόπηση](https://docs.claude-mem.ai/architecture/overview)** - Συστατικά στοιχεία συστήματος & ροή δεδομένων
- **[Εξέλιξη Αρχιτεκτονικής](https://docs.claude-mem.ai/architecture-evolution)** - Το ταξίδι από το v3 στο v5
- **[Αρχιτεκτονική Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Πώς το Claude-Mem χρησιμοποιεί lifecycle hooks
- **[Αναφορά Hooks](https://docs.claude-mem.ai/architecture/hooks)** - Επεξήγηση 7 hook scripts
- **[Υπηρεσία Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & διαχείριση Bun
- **[Βάση Δεδομένων](https://docs.claude-mem.ai/architecture/database)** - Σχήμα SQLite & αναζήτηση FTS5
- **[Αρχιτεκτονική Αναζήτησης](https://docs.claude-mem.ai/architecture/search-architecture)** - Υβριδική αναζήτηση με βάση δεδομένων διανυσμάτων Chroma

### Διαμόρφωση & Ανάπτυξη

- **[Διαμόρφωση](https://docs.claude-mem.ai/configuration)** - Μεταβλητές περιβάλλοντος & ρυθμίσεις
- **[Ανάπτυξη](https://docs.claude-mem.ai/development)** - Κατασκευή, δοκιμή, συνεισφορά
- **[Αντιμετώπιση Προβλημάτων](https://docs.claude-mem.ai/troubleshooting)** - Συνήθη προβλήματα & λύσεις

---

## Πώς Λειτουργεί

**Βασικά Συστατικά:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Έξυπνη Εγκατάσταση** - Έλεγχος εξαρτήσεων με cache (pre-hook script, όχι lifecycle hook)
3. **Υπηρεσία Worker** - HTTP API στη θύρα 37777 με διεπαφή web viewer και 10 endpoints αναζήτησης, διαχειριζόμενη από το Bun
4. **Βάση Δεδομένων SQLite** - Αποθηκεύει συνεδρίες, παρατηρήσεις, περιλήψεις
5. **Δεξιότητα mem-search** - Ερωτήματα φυσικής γλώσσας με προοδευτική αποκάλυψη
6. **Βάση Δεδομένων Διανυσμάτων Chroma** - Υβριδική σημασιολογική + αναζήτηση λέξεων-κλειδιών για έξυπνη ανάκτηση πλαισίου

Δείτε [Επισκόπηση Αρχιτεκτονικής](https://docs.claude-mem.ai/architecture/overview) για λεπτομέρειες.

---

## Δεξιότητα mem-search

Το Claude-Mem παρέχει έξυπνη αναζήτηση μέσω της δεξιότητας mem-search που ενεργοποιείται αυτόματα όταν ρωτάτε για παλαιότερη εργασία:

**Πώς Λειτουργεί:**
- Απλά ρωτήστε φυσικά: *"Τι κάναμε την προηγούμενη συνεδρία;"* ή *"Διορθώσαμε αυτό το σφάλμα νωρίτερα;"*
- Το Claude ενεργοποιεί αυτόματα τη δεξιότητα mem-search για να βρει σχετικό πλαίσιο

**Διαθέσιμες Λειτουργίες Αναζήτησης:**

1. **Search Observations** - Αναζήτηση πλήρους κειμένου σε παρατηρήσεις
2. **Search Sessions** - Αναζήτηση πλήρους κειμένου σε περιλήψεις συνεδριών
3. **Search Prompts** - Αναζήτηση ακατέργαστων αιτημάτων χρήστη
4. **By Concept** - Εύρεση βάσει ετικετών εννοιών (discovery, problem-solution, pattern, κ.λπ.)
5. **By File** - Εύρεση παρατηρήσεων που αναφέρονται σε συγκεκριμένα αρχεία
6. **By Type** - Εύρεση βάσει τύπου (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Λήψη πρόσφατου πλαισίου συνεδρίας για ένα έργο
8. **Timeline** - Λήψη ενοποιημένης χρονολογικής γραμμής πλαισίου γύρω από συγκεκριμένο χρονικό σημείο
9. **Timeline by Query** - Αναζήτηση παρατηρήσεων και λήψη πλαισίου χρονολογικής γραμμής γύρω από την καλύτερη αντιστοιχία
10. **API Help** - Λήψη τεκμηρίωσης API αναζήτησης

**Παραδείγματα Ερωτημάτων Φυσικής Γλώσσας:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

Δείτε [Οδηγό Εργαλείων Αναζήτησης](https://docs.claude-mem.ai/usage/search-tools) για λεπτομερή παραδείγματα.

---

## Χαρακτηριστικά Beta

Το Claude-Mem προσφέρει ένα **κανάλι beta** με πειραματικά χαρακτηριστικά όπως το **Endless Mode** (βιομιμητική αρχιτεκτονική μνήμης για εκτεταμένες συνεδρίες). Εναλλαγή μεταξύ σταθερών και beta εκδόσεων από τη διεπαφή web viewer στο http://localhost:37777 → Settings.

Δείτε **[Τεκμηρίωση Χαρακτηριστικών Beta](https://docs.claude-mem.ai/beta-features)** για λεπτομέρειες σχετικά με το Endless Mode και πώς να το δοκιμάσετε.

---

## Απαιτήσεις Συστήματος

- **Node.js**: 18.0.0 ή νεότερο
- **Claude Code**: Τελευταία έκδοση με υποστήριξη plugin
- **Bun**: JavaScript runtime και διαχειριστής διεργασιών (εγκαθίσταται αυτόματα αν λείπει)
- **uv**: Διαχειριστής πακέτων Python για αναζήτηση διανυσμάτων (εγκαθίσταται αυτόματα αν λείπει)
- **SQLite 3**: Για μόνιμη αποθήκευση (συμπεριλαμβάνεται)

---

## Διαμόρφωση

Οι ρυθμίσεις διαχειρίζονται στο `~/.claude-mem/settings.json` (δημιουργείται αυτόματα με προεπιλογές κατά την πρώτη εκτέλεση). Διαμορφώστε το μοντέλο AI, τη θύρα worker, τον κατάλογο δεδομένων, το επίπεδο καταγραφής και τις ρυθμίσεις εισαγωγής πλαισίου.

Δείτε τον **[Οδηγό Διαμόρφωσης](https://docs.claude-mem.ai/configuration)** για όλες τις διαθέσιμες ρυθμίσεις και παραδείγματα.

---

## Ανάπτυξη

Δείτε τον **[Οδηγό Ανάπτυξης](https://docs.claude-mem.ai/development)** για οδηγίες κατασκευής, δοκιμών και ροής εργασίας συνεισφοράς.

---

## Αντιμετώπιση Προβλημάτων

Εάν αντιμετωπίζετε προβλήματα, περιγράψτε το πρόβλημα στο Claude και η δεξιότητα troubleshoot θα διαγνώσει αυτόματα και θα παράσχει λύσεις.

Δείτε τον **[Οδηγό Αντιμετώπισης Προβλημάτων](https://docs.claude-mem.ai/troubleshooting)** για συνήθη προβλήματα και λύσεις.

---

## Αναφορές Σφαλμάτων

Δημιουργήστε περιεκτικές αναφορές σφαλμάτων με την αυτοματοποιημένη γεννήτρια:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Συνεισφορά

Οι συνεισφορές είναι ευπρόσδεκτες! Παρακαλώ:

1. Κάντε Fork το repository
2. Δημιουργήστε ένα feature branch
3. Κάντε τις αλλαγές σας με δοκιμές
4. Ενημερώστε την τεκμηρίωση
5. Υποβάλετε ένα Pull Request

Δείτε τον [Οδηγό Ανάπτυξης](https://docs.claude-mem.ai/development) για τη ροή εργασίας συνεισφοράς.

---

## Άδεια Χρήσης

Αυτό το έργο διατίθεται με άδεια **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Με επιφύλαξη παντός δικαιώματος.

Δείτε το αρχείο [LICENSE](LICENSE) για πλήρεις λεπτομέρειες.

**Τι Σημαίνει Αυτό:**

- Μπορείτε να χρησιμοποιήσετε, να τροποποιήσετε και να διανείμετε ελεύθερα αυτό το λογισμικό
- Εάν τροποποιήσετε και αναπτύξετε σε διακομιστή δικτύου, πρέπει να καταστήσετε διαθέσιμο τον πηγαίο κώδικά σας
- Τα παράγωγα έργα πρέπει επίσης να διατίθενται με άδεια AGPL-3.0
- ΔΕΝ υπάρχει ΕΓΓΥΗΣΗ για αυτό το λογισμικό

**Σημείωση για το Ragtime**: Ο κατάλογος `ragtime/` διατίθεται χωριστά με άδεια **PolyForm Noncommercial License 1.0.0**. Δείτε το [ragtime/LICENSE](ragtime/LICENSE) για λεπτομέρειες.

---

## Υποστήριξη

- **Τεκμηρίωση**: [docs/](docs/)
- **Ζητήματα**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Συγγραφέας**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Κατασκευασμένο με Claude Agent SDK** | **Τροφοδοτείται από Claude Code** | **Φτιαγμένο με TypeScript**