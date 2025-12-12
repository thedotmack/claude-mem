🌐 זהו תרגום אוטומטי. תיקונים מהקהילה יתקבלו בברכה!

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

<h4 align="center">מערכת דחיסת זיכרון קבוע שנבנתה עבור <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

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
  <a href="#התחלה-מהירה">התחלה מהירה</a> •
  <a href="#איך-זה-עובד">איך זה עובד</a> •
  <a href="#כלי-חיפוש-mcp">כלי חיפוש</a> •
  <a href="#תיעוד">תיעוד</a> •
  <a href="#תצורה">תצורה</a> •
  <a href="#פתרון-בעיות">פתרון בעיות</a> •
  <a href="#רישיון">רישיון</a>
</p>

<p align="center">
  Claude-Mem שומר על הקשר בצורה חלקה לאורך הפעלות על ידי לכידה אוטומטית של תצפיות שימוש בכלים, יצירת סיכומים סמנטיים, והפיכתם לזמינים להפעלות עתידיות. זה מאפשר ל-Claude לשמור על המשכיות של ידע על פרויקטים גם לאחר שההפעלות מסתיימות או מתחברות מחדש.
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

- 🧠 **זיכרון קבוע** - ההקשר שורד לאורך הפעלות
- 📊 **גילוי הדרגתי** - אחזור זיכרון מרובד עם נראות עלות אסימונים
- 🔍 **חיפוש מבוסס מיומנויות** - שאל את היסטוריית הפרויקט שלך עם מיומנות mem-search (חיסכון של ~2,250 אסימונים)
- 🖥️ **ממשק צופה ווב** - זרם זיכרון בזמן אמת ב-http://localhost:37777
- 🔒 **בקרת פרטיות** - השתמש בתגי `<private>` כדי להחריג תוכן רגיש מאחסון
- ⚙️ **תצורת הקשר** - בקרה מפורטת על איזה הקשר מוזרק
- 🤖 **תפעול אוטומטי** - אין צורך בהתערבות ידנית
- 🔗 **ציטוטים** - הפנה להחלטות קודמות עם URIs של `claude-mem://`
- 🧪 **ערוץ בטא** - נסה תכונות ניסיוניות כמו Endless Mode באמצעות החלפת גרסאות

---

## תיעוד

📚 **[צפה בתיעוד המלא](docs/)** - עיין במסמכי markdown ב-GitHub

💻 **תצוגה מקדימה מקומית**: הרץ מסמכי Mintlify באופן מקומי:

```bash
cd docs
npx mintlify dev
```

### תחילת עבודה

- **[מדריך התקנה](https://docs.claude-mem.ai/installation)** - התחלה מהירה והתקנה מתקדמת
- **[מדריך שימוש](https://docs.claude-mem.ai/usage/getting-started)** - איך Claude-Mem עובד אוטומטית
- **[כלי חיפוש](https://docs.claude-mem.ai/usage/search-tools)** - שאל את היסטוריית הפרויקט שלך בשפה טבעית
- **[תכונות בטא](https://docs.claude-mem.ai/beta-features)** - נסה תכונות ניסיוניות כמו Endless Mode

### שיטות עבודה מומלצות

- **[הנדסת הקשר](https://docs.claude-mem.ai/context-engineering)** - עקרונות אופטימיזציה של הקשר לסוכן AI
- **[גילוי הדרגתי](https://docs.claude-mem.ai/progressive-disclosure)** - הפילוסופיה מאחורי אסטרטגיית ההכנה להקשר של Claude-Mem

### ארכיטקטורה

- **[סקירה כללית](https://docs.claude-mem.ai/architecture/overview)** - רכיבי מערכת וזרימת נתונים
- **[התפתחות ארכיטקטורה](https://docs.claude-mem.ai/architecture-evolution)** - המסע מ-v3 ל-v5
- **[ארכיטקטורת Hooks](https://docs.claude-mem.ai/hooks-architecture)** - איך Claude-Mem משתמש ב-lifecycle hooks
- **[מדריך Hooks](https://docs.claude-mem.ai/architecture/hooks)** - הסבר על 7 סקריפטי hook
- **[שירות Worker](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API וניהול PM2
- **[מסד נתונים](https://docs.claude-mem.ai/architecture/database)** - סכמת SQLite וחיפוש FTS5
- **[ארכיטקטורת חיפוש](https://docs.claude-mem.ai/architecture/search-architecture)** - חיפוש היברידי עם מסד נתונים וקטורי Chroma

### תצורה ופיתוח

- **[תצורה](https://docs.claude-mem.ai/configuration)** - משתני סביבה והגדרות
- **[פיתוח](https://docs.claude-mem.ai/development)** - בנייה, בדיקה, תרומה
- **[פתרון בעיות](https://docs.claude-mem.ai/troubleshooting)** - בעיות נפוצות ופתרונות

---

## איך זה עובד

```
┌─────────────────────────────────────────────────────────────┐
│ התחלת הפעלה → הזרק תצפיות אחרונות כהקשר                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ בקשות משתמש → צור הפעלה, שמור בקשות משתמש                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ביצועי כלים → לכוד תצפיות (Read, Write וכו')                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ תהליכי Worker → חלץ לקחים באמצעות Claude Agent SDK          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ סיום הפעלה → צור סיכום, מוכן להפעלה הבאה                    │
└─────────────────────────────────────────────────────────────┘
```

**רכיבי ליבה:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 סקריפטי hook)
2. **התקנה חכמה** - בודק תלויות במטמון (סקריפט pre-hook, לא lifecycle hook)
3. **שירות Worker** - HTTP API על פורט 37777 עם ממשק צופה ווב ו-10 נקודות קצה לחיפוש, מנוהל על ידי PM2
4. **מסד נתונים SQLite** - מאחסן הפעלות, תצפיות, סיכומים עם חיפוש טקסט מלא FTS5
5. **מיומנות mem-search** - שאילתות בשפה טבעית עם גילוי הדרגתי (חיסכון של ~2,250 אסימונים לעומת MCP)
6. **מסד נתונים וקטורי Chroma** - חיפוש היברידי סמנטי + מילות מפתח לאחזור הקשר חכם

ראה [סקירה כללית של ארכיטקטורה](https://docs.claude-mem.ai/architecture/overview) לפרטים.

---

## מיומנות mem-search

Claude-Mem מספק חיפוש חכם דרך מיומנות mem-search שמופעלת אוטומטית כאשר אתה שואל על עבודה קודמת:

**איך זה עובד:**
- פשוט שאל באופן טבעי: *"מה עשינו בהפעלה האחרונה?"* או *"תיקננו את הבאג הזה בעבר?"*
- Claude מפעיל אוטומטית את מיומנות mem-search כדי למצוא הקשר רלוונטי
- חיסכון של ~2,250 אסימונים בכל התחלת הפעלה לעומת גישת MCP

**פעולות חיפוש זמינות:**

1. **חיפוש תצפיות** - חיפוש טקסט מלא על פני תצפיות
2. **חיפוש הפעלות** - חיפוש טקסט מלא על פני סיכומי הפעלות
3. **חיפוש בקשות** - חיפוש בקשות משתמש גולמיות
4. **לפי קונספט** - מצא לפי תגי קונספט (discovery, problem-solution, pattern וכו')
5. **לפי קובץ** - מצא תצפיות המתייחסות לקבצים ספציפיים
6. **לפי סוג** - מצא לפי סוג (decision, bugfix, feature, refactor, discovery, change)
7. **הקשר אחרון** - קבל הקשר הפעלה אחרון לפרויקט
8. **ציר זמן** - קבל ציר זמן מאוחד של הקשר סביב נקודה ספציפית בזמן
9. **ציר זמן לפי שאילתה** - חפש תצפיות וקבל הקשר ציר זמן סביב ההתאמה הטובה ביותר
10. **עזרת API** - קבל תיעוד API של חיפוש

**דוגמאות לשאילתות בשפה טבעית:**

```
"אילו באגים תיקננו בהפעלה האחרונה?"
"איך יישמנו אימות?"
"אילו שינויים נעשו ב-worker-service.ts?"
"הראה לי עבודה אחרונה על הפרויקט הזה"
"מה קרה כשהוספנו את ממשק הצופה?"
```

ראה [מדריך כלי חיפוש](https://docs.claude-mem.ai/usage/search-tools) לדוגמאות מפורטות.

---

## תכונות בטא ו-Endless Mode

Claude-Mem מציע **ערוץ בטא** עם תכונות ניסיוניות. החלף בין גרסאות יציבות ובטא ישירות מממשק הצופה בווב.

### איך לנסות בטא

1. פתח http://localhost:37777
2. לחץ על הגדרות (אייקון גלגל שיניים)
3. ב-**Version Channel**, לחץ על "Try Beta (Endless Mode)"
4. המתן ל-worker להפעיל מחדש

נתוני הזיכרון שלך נשמרים בעת החלפת גרסאות.

### Endless Mode (בטא)

תכונת הבטא המרכזית היא **Endless Mode** - ארכיטקטורת זיכרון ביו-ממטית שמרחיבה באופן דרמטי את אורך ההפעלה:

**הבעיה**: הפעלות Claude Code סטנדרטיות מגיעות למגבלות הקשר לאחר ~50 שימושי כלים. כל כלי מוסיף 1-10k+ אסימונים, ו-Claude מסנתז מחדש את כל הפלטים הקודמים בכל תגובה (מורכבות O(N²)).

**הפתרון**: Endless Mode דוחס פלטי כלים לתצפיות של ~500 אסימונים וממיר את התמליל בזמן אמת:

```
זיכרון עבודה (הקשר):     תצפיות דחוסות (~500 אסימונים כל אחת)
זיכרון ארכיון (דיסק):      פלטי כלים מלאים נשמרים לשליפה
```

**תוצאות צפויות**:
- הפחתת ~95% באסימונים בחלון הקשר
- פי ~20 יותר שימושי כלים לפני מיצוי הקשר
- סקלה ליניארית O(N) במקום ריבועית O(N²)
- תמלילים מלאים נשמרים לשליפה מושלמת

**אזהרות**: מוסיף חביון (60-90 שניות לכל כלי ליצירת תצפית), עדיין ניסיוני.

ראה [תיעוד תכונות בטא](https://docs.claude-mem.ai/beta-features) לפרטים.

---

## מה חדש

**v6.4.9 - הגדרות תצורת הקשר:**
- 11 הגדרות חדשות לבקרה מפורטת על הזרקת הקשר
- הגדר תצוגת כלכלת אסימונים, סינון תצפיות לפי סוג/קונספט
- שלוט במספר התצפיות ואילו שדות להציג

**v6.4.0 - מערכת פרטיות דו-תגית:**
- תגי `<private>` לפרטיות בשליטת משתמש - עטוף תוכן רגיש כדי להחריג מאחסון
- תגי `<claude-mem-context>` ברמת מערכת מונעים אחסון תצפיות רקורסיבי
- עיבוד קצה מבטיח שתוכן פרטי לעולם לא מגיע למסד הנתונים

**v6.3.0 - ערוץ גרסה:**
- החלף בין גרסאות יציבות ובטא מממשק הצופה בווב
- נסה תכונות ניסיוניות כמו Endless Mode ללא פעולות git ידניות

**דגשים קודמים:**
- **v6.0.0**: שיפורים משמעותיים בניהול הפעלות ועיבוד תמלילים
- **v5.5.0**: שיפור מיומנות mem-search עם שיעור יעילות של 100%
- **v5.4.0**: ארכיטקטורת חיפוש מבוססת מיומנויות (2,250 אסימונים נחסכים בכל הפעלה)
- **v5.1.0**: ממשק צופה מבוסס ווב עם עדכונים בזמן אמת
- **v5.0.0**: חיפוש היברידי עם מסד נתונים וקטורי Chroma

ראה [CHANGELOG.md](CHANGELOG.md) להיסטוריה מלאה של גרסאות.

---

## דרישות מערכת

- **Node.js**: 18.0.0 ומעלה
- **Claude Code**: גרסה אחרונה עם תמיכת תוספים
- **PM2**: מנהל תהליכים (מצורף - אין צורך בהתקנה גלובלית)
- **SQLite 3**: לאחסון קבוע (מצורף)

---

## יתרונות מרכזיים

### הקשר גילוי הדרגתי

- **אחזור זיכרון מרובד** משקף דפוסי זיכרון אנושיים
- **שכבה 1 (אינדקס)**: ראה אילו תצפיות קיימות עם עלויות אסימונים בתחילת הפעלה
- **שכבה 2 (פרטים)**: אחזר נרטיבים מלאים לפי דרישה באמצעות חיפוש MCP
- **שכבה 3 (שליפה מושלמת)**: גישה לקוד מקור ותמלילים מקוריים
- **קבלת החלטות חכמה**: ספירת אסימונים עוזרת ל-Claude לבחור בין אחזור פרטים או קריאת קוד
- **מחווני סוג**: רמזים ויזואליים (🔴 קריטי, 🟤 החלטה, 🔵 אינפורמטיבי) מדגישים חשיבות תצפית

### זיכרון אוטומטי

- הקשר מוזרק אוטומטית כאשר Claude מתחיל
- אין צורך בפקודות ידניות או תצורה
- עובד בשקיפות ברקע

### חיפוש היסטוריה מלא

- חפש על פני כל ההפעלות והתצפיות
- חיפוש טקסט מלא FTS5 לשאילתות מהירות
- ציטוטים מקשרים בחזרה לתצפיות ספציפיות

### תצפיות מובנות

- חילוץ מופעל AI של לקחים
- מקוטלג לפי סוג (decision, bugfix, feature וכו')
- מתויג עם קונספטים והפניות לקבצים

### הפעלות מרובות בקשות

- הפעלות משתרעות על מספר בקשות משתמש
- הקשר נשמר על פני פקודות `/clear`
- עקוב אחר שרשורי שיחה שלמים

---

## תצורה

הגדרות מנוהלות ב-`~/.claude-mem/settings.json`. הקובץ נוצר אוטומטית עם ברירות מחדל בהפעלה הראשונה.

**הגדרות זמינות:**

| הגדרה | ברירת מחדל | תיאור |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | מודל AI לתצפיות |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | פורט שירות worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | מיקום תיקיית נתונים |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | רמת פירוט לוג (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | גרסת Python ל-chroma-mcp |
| `CLAUDE_CODE_PATH` | _(זיהוי אוטומטי)_ | נתיב לקובץ הפעלה של Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | מספר תצפיות להזרקה ב-SessionStart |

**ניהול הגדרות:**

```bash
# ערוך הגדרות דרך עוזר CLI
./claude-mem-settings.sh

# או ערוך ישירות
nano ~/.claude-mem/settings.json

# צפה בהגדרות נוכחיות
curl http://localhost:37777/api/settings
```

**פורמט קובץ הגדרות:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

ראה [מדריך תצורה](https://docs.claude-mem.ai/configuration) לפרטים.

---

## פיתוח

```bash
# שכפל ובנה
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# הרץ בדיקות
npm test

# התחל worker
npm run worker:start

# צפה בלוגים
npm run worker:logs
```

ראה [מדריך פיתוח](https://docs.claude-mem.ai/development) להוראות מפורטות.

---

## פתרון בעיות

**אבחון מהיר:**

אם אתה נתקל בבעיות, תאר את הבעיה ל-Claude ומיומנות troubleshoot תופעל אוטומטית כדי לאבחן ולספק תיקונים.

**בעיות נפוצות:**

- Worker לא מתחיל → `npm run worker:restart`
- הקשר לא מופיע → `npm run test:context`
- בעיות מסד נתונים → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- חיפוש לא עובד → בדוק שטבלאות FTS5 קיימות

ראה [מדריך פתרון בעיות](https://docs.claude-mem.ai/troubleshooting) לפתרונות מלאים.

---

## תרומה

תרומות מתקבלות בברכה! אנא:

1. עשה fork למאגר
2. צור ענף תכונה
3. בצע את השינויים שלך עם בדיקות
4. עדכן תיעוד
5. שלח Pull Request

ראה [מדריך פיתוח](https://docs.claude-mem.ai/development) לזרימת עבודה של תרומה.

---

## רישיון

פרויקט זה מורשה תחת **GNU Affero General Public License v3.0** (AGPL-3.0).

זכויות יוצרים (C) 2025 Alex Newman (@thedotmack). כל הזכויות שמורות.

ראה את קובץ [LICENSE](LICENSE) לפרטים מלאים.

**מה זה אומר:**

- אתה יכול להשתמש, לשנות ולהפיץ תוכנה זו בחופשיות
- אם אתה משנה ומפרס על שרת רשת, עליך להפוך את קוד המקור שלך לזמין
- עבודות נגזרות חייבות גם להיות מורשות תחת AGPL-3.0
- אין אחריות לתוכנה זו

---

## תמיכה

- **תיעוד**: [docs/](docs/)
- **בעיות**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **מאגר**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **מחבר**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**נבנה עם Claude Agent SDK** | **מופעל על ידי Claude Code** | **נוצר עם TypeScript**