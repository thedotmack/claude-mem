🌐 זהו תרגום אוטומטי. תיקונים מהקהילה יתקבלו בברכה!

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

<h4 align="center">מערכת דחיסת זיכרון מתמשך שנבנתה עבור <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#quick-start">התחלה מהירה</a> •
  <a href="#how-it-works">איך זה עובד</a> •
  <a href="#mcp-search-tools">כלי חיפוש</a> •
  <a href="#documentation">תיעוד</a> •
  <a href="#configuration">הגדרות</a> •
  <a href="#troubleshooting">פתרון בעיות</a> •
  <a href="#license">רישיון</a>
</p>

<p align="center">
  Claude-Mem משמר הקשר בצורה חלקה בין הפעלות על ידי לכידה אוטומטית של תצפיות על שימוש בכלים, יצירת סיכומים סמנטיים, והנגשתם להפעלות עתידיות. זה מאפשר ל-Claude לשמור על המשכיות של ידע על פרויקטים גם לאחר שהפעלות מסתיימות או מתחברות מחדש.
</p>

---

## התחלה מהירה

התחל הפעלה חדשה של Claude Code בטרמינל והזן את הפקודות הבאות:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

הפעל מחדש את Claude Code. הקשר מהפעלות קודמות יופיע אוטומטית בהפעלות חדשות.

**תכונות עיקריות:**

- 🧠 **זיכרון מתמשך** - הקשר שורד בין הפעלות
- 📊 **גילוי מדורג** - אחזור זיכרון רב-שכבתי עם נראות עלות טוקנים
- 🔍 **חיפוש מבוסס-מיומנויות** - שאל את היסטוריית הפרויקט שלך עם מיומנות mem-search
- 🖥️ **ממשק צופה אינטרנט** - זרימת זיכרון בזמן אמת ב-http://localhost:37777
- 💻 **מיומנות Claude Desktop** - חפש זיכרון משיחות Claude Desktop
- 🔒 **בקרת פרטיות** - השתמש בתגיות `<private>` כדי להוציא תוכן רגיש מהאחסון
- ⚙️ **הגדרות הקשר** - בקרה מדויקת על איזה הקשר מוזרק
- 🤖 **פעולה אוטומטית** - אין צורך בהתערבות ידנית
- 🔗 **ציטוטים** - הפנה לתצפיות קודמות עם מזהים (גישה דרך http://localhost:37777/api/observation/{id} או צפה בכולם בצופה האינטרנט ב-http://localhost:37777)
- 🧪 **ערוץ בטא** - נסה תכונות ניסיוניות כמו Endless Mode דרך החלפת גרסאות

---

## תיעוד

📚 **[צפה בתיעוד המלא](https://docs.claude-mem.ai/)** - דפדף באתר הרשמי

### תחילת העבודה

- **[מדריך התקנה](https://docs.claude-mem.ai/installation)** - התחלה מהירה והתקנה מתקדמת
- **[מדריך שימוש](https://docs.claude-mem.ai/usage/getting-started)** - איך Claude-Mem עובד אוטומטית
- **[כלי חיפוש](https://docs.claude-mem.ai/usage/search-tools)** - שאל את היסטוריית הפרויקט שלך בשפה טבעית
- **[תכונות בטא](https://docs.claude-mem.ai/beta-features)** - נסה תכונות ניסיוניות כמו Endless Mode

### שיטות מומלצות

- **[הנדסת הקשר](https://docs.claude-mem.ai/context-engineering)** - עקרונות אופטימיזציה של הקשר לסוכן AI
- **[גילוי מדורג](https://docs.claude-mem.ai/progressive-disclosure)** - הפילוסופיה מאחורי אסטרטגיית הכנת ההקשר של Claude-Mem

### ארכיטקטורה

- **[סקירה כללית](https://docs.claude-mem.ai/architecture/overview)** - רכיבי המערכת וזרימת הנתונים
- **[התפתחות הארכיטקטורה](https://docs.claude-mem.ai/architecture-evolution)** - המסע מגרסה 3 לגרסה 5
- **[ארכיטקטורת Hooks](https://docs.claude-mem.ai/hooks-architecture)** - איך Claude-Mem משתמש ב-lifecycle hooks
- **[מדריך Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 סקריפטי hook מוסברים
- **[שירות Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API וניהול Bun
- **[מסד נתונים](https://docs.claude-mem.ai/architecture/database)** - סכמת SQLite וחיפוש FTS5
- **[ארכיטקטורת חיפוש](https://docs.claude-mem.ai/architecture/search-architecture)** - חיפוש היברידי עם מסד נתוני וקטורים Chroma

### הגדרות ופיתוח

- **[הגדרות](https://docs.claude-mem.ai/configuration)** - משתני סביבה והגדרות
- **[פיתוח](https://docs.claude-mem.ai/development)** - בנייה, בדיקה, תרומה
- **[פתרון בעיות](https://docs.claude-mem.ai/troubleshooting)** - בעיות נפוצות ופתרונות

---

## איך זה עובד

**רכיבי ליבה:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 סקריפטי hook)
2. **התקנה חכמה** - בודק תלויות עם מטמון (סקריפט pre-hook, לא lifecycle hook)
3. **שירות Worker** - HTTP API על פורט 37777 עם ממשק צופה אינטרנט ו-10 נקודות קצה לחיפוש, מנוהל על ידי Bun
4. **מסד נתוני SQLite** - מאחסן הפעלות, תצפיות, סיכומים
5. **מיומנות mem-search** - שאילתות בשפה טבעית עם גילוי מדורג
6. **מסד נתוני וקטורים Chroma** - חיפוש היברידי סמנטי + מילות מפתח לאחזור הקשר חכם

ראה [סקירה כללית של הארכיטקטורה](https://docs.claude-mem.ai/architecture/overview) לפרטים.

---

## מיומנות mem-search

Claude-Mem מספק חיפוש חכם דרך מיומנות mem-search שמופעלת אוטומטית כשאתה שואל על עבודה קודמת:

**איך זה עובד:**
- פשוט שאל באופן טבעי: *"מה עשינו בהפעלה האחרונה?"* או *"תיקנו את הבאג הזה קודם?"*
- Claude מפעיל אוטומטית את מיומנות mem-search כדי למצוא הקשר רלוונטי

**פעולות חיפוש זמינות:**

1. **חיפוש תצפיות** - חיפוש טקסט מלא על פני תצפיות
2. **חיפוש הפעלות** - חיפוש טקסט מלא על פני סיכומי הפעלות
3. **חיפוש Prompts** - חיפוש בקשות משתמש גולמיות
4. **לפי מושג** - חיפוש לפי תגיות מושג (discovery, problem-solution, pattern, וכו')
5. **לפי קובץ** - חיפוש תצפיות המתייחסות לקבצים ספציפיים
6. **לפי סוג** - חיפוש לפי סוג (decision, bugfix, feature, refactor, discovery, change)
7. **הקשר אחרון** - קבל הקשר הפעלות אחרון לפרויקט
8. **ציר זמן** - קבל ציר זמן מאוחד של הקשר סביב נקודת זמן ספציפית
9. **ציר זמן לפי שאילתה** - חפש תצפיות וקבל הקשר ציר זמן סביב ההתאמה הטובה ביותר
10. **עזרה ל-API** - קבל תיעוד API חיפוש

**דוגמאות לשאילתות בשפה טבעית:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

ראה [מדריך כלי חיפוש](https://docs.claude-mem.ai/usage/search-tools) לדוגמאות מפורטות.

---

## תכונות בטא

Claude-Mem מציע **ערוץ בטא** עם תכונות ניסיוניות כמו **Endless Mode** (ארכיטקטורת זיכרון ביומימטית להפעלות מורחבות). החלף בין גרסאות יציבות ובטא מממשק הצופה האינטרנט ב-http://localhost:37777 → Settings.

ראה **[תיעוד תכונות בטא](https://docs.claude-mem.ai/beta-features)** לפרטים על Endless Mode ואיך לנסות אותו.

---

## דרישות מערכת

- **Node.js**: 18.0.0 ומעלה
- **Claude Code**: גרסה אחרונה עם תמיכה בתוספים
- **Bun**: סביבת ריצה ומנהל תהליכים של JavaScript (מותקן אוטומטית אם חסר)
- **uv**: מנהל חבילות Python לחיפוש וקטורי (מותקן אוטומטית אם חסר)
- **SQLite 3**: לאחסון מתמשך (מצורף)

---

## הגדרות

ההגדרות מנוהלות ב-`~/.claude-mem/settings.json` (נוצר אוטומטית עם ברירות מחדל בהפעלה הראשונה). הגדר מודל AI, פורט worker, ספריית נתונים, רמת לוג, והגדרות הזרקת הקשר.

ראה **[מדריך הגדרות](https://docs.claude-mem.ai/configuration)** לכל ההגדרות הזמינות ודוגמאות.

---

## פיתוח

ראה **[מדריך פיתוח](https://docs.claude-mem.ai/development)** להוראות בנייה, בדיקה, ותהליך תרומה.

---

## פתרון בעיות

אם אתה נתקל בבעיות, תאר את הבעיה ל-Claude ומיומנות troubleshoot תאבחן אוטומטית ותספק תיקונים.

ראה **[מדריך פתרון בעיות](https://docs.claude-mem.ai/troubleshooting)** לבעיות נפוצות ופתרונות.

---

## דיווחי באגים

צור דיווחי באגים מקיפים עם המחולל האוטומטי:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## תרומה

תרומות מתקבלות בברכה! אנא:

1. עשה Fork למאגר
2. צור ענף תכונה
3. בצע את השינויים שלך עם בדיקות
4. עדכן תיעוד
5. שלח Pull Request

ראה [מדריך פיתוח](https://docs.claude-mem.ai/development) לתהליך תרומה.

---

## רישיון

פרויקט זה מורשה תחת **GNU Affero General Public License v3.0** (AGPL-3.0).

זכויות יוצרים (C) 2025 Alex Newman (@thedotmack). כל הזכויות שמורות.

ראה את קובץ [LICENSE](LICENSE) לפרטים מלאים.

**משמעות הדבר:**

- אתה יכול לשימוש, שינוי והפצה של תוכנה זו בחופשיות
- אם אתה משנה ופורס על שרת רשת, עליך להנגיש את קוד המקור שלך
- עבודות נגזרות חייבות להיות מורשות גם כן תחת AGPL-3.0
- אין אחריות לתוכנה זו

**הערה על Ragtime**: ספריית `ragtime/` מורשית בנפרד תחת **PolyForm Noncommercial License 1.0.0**. ראה [ragtime/LICENSE](ragtime/LICENSE) לפרטים.

---

## תמיכה

- **תיעוד**: [docs/](docs/)
- **בעיות**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **מאגר**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **מחבר**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**נבנה עם Claude Agent SDK** | **מופעל על ידי Claude Code** | **נוצר עם TypeScript**