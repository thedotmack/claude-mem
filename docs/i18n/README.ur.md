<section dir="rtl">
🌐 یہ ایک خودکار ترجمہ ہے۔ کمیونٹی کی اصلاحات کا خیر مقدم ہے!

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

<p align="center" dir="ltr">
  <a href="README.zh.md">🇨🇳 中文</a> •
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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a> کے لیے بنایا گیا مستقل میموری کمپریشن سسٹم۔</h4>

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
  <a href="#تیز-رفتار-شروعات">تیز رفتار شروعات</a> •
  <a href="#یہ-کیسے-کام-کرتا-ہے">یہ کیسے کام کرتا ہے</a> •
  <a href="#تلاش-کے-اوزار">تلاش کے اوزار</a> •
  <a href="#دستاویزات">دستاویزات</a> •
  <a href="#ترتیبات">ترتیبات</a> •
  <a href="#مسائل-کی-تشخیص">مسائل کی تشخیص</a> •
  <a href="#لائسنس">لائسنس</a>
</p>

<p align="center">
  Claude-Mem خودکار طور پر ٹول کے استعمال کے بعد کے مشاہدات کو ریکارڈ کرتا ہے، سیمانٹک خلاصے تیار کرتا ہے اور انہیں مستقبل کے سیشنز میں دستیاب کرتا ہے تاکہ آپ سیشن میں براہ راست تناسب محفوظ رہے۔ یہ Claude کو سیشن ختم ہونے یا دوبارہ جڑنے کے بعد بھی منصوبے کے بارے میں معلومات کی مسلسلیت برقرار رکھنے کے قابل بناتا ہے۔
</p>

---

## تیز رفتار شروعات

ٹرمنل میں نیا Claude Code سیشن شروع کریں اور ہیں کمانڈز درج کریں:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code کو دوبارہ شروع کریں۔ سابقہ سیشن کا تناسب خودکار طور پر نئے سیشن میں موجود ہوگا۔

**اہم خصوصیات:**

- 🧠 **مستقل میموری** - تناسب سیشن کے دوران برقرار رہتا ہے
- 📊 **بتدریج ظہور** - لیئرڈ میموری کی بازیافت ٹوکن کی لاگت کی نمائندگی کے ساتھ
- 🔍 **کمکردہ تلاش** - mem-search مہارت کے ساتھ اپنے منصوبے کی تاریخ میں تلاش کریں
- 🖥️ **ویب ویور یو آئی** - http://localhost:37777 پر حقیقی وقت میموری اسٹریم
- 💻 **Claude Desktop مہارت** - Claude Desktop بات چیت سے میموری تلاش کریں
- 🔒 **رازداری کے کنٹرولز** - حساس مواد کو ذخیرہ سے خارج کرنے کے لیے `<private>` ٹیگ استعمال کریں
- ⚙️ **تناسب کی ترتیبات** - کون سا تناسب انجیکٹ کیا جائے اس پر باریک کنٹرول
- 🤖 **خودکار آپریشن** - کسی دستی مداخلت کی ضرورت نہیں
- 🔗 **حوالہ** - ID کے ذریعے سابقہ مشاہدات کا حوالہ دیں (http://localhost:37777/api/observation/{id} کے ذریعے رسائی حاصل کریں یا تمام کو http://localhost:37777 پر ویب ویور میں دیکھیں)
- 🧪 **بیٹا چینل** - ورژن تبدیل کرنے کے ذریعے Endless Mode جیسی تجرباتی خصوصیات آزمائیں

---

## دستاویزات

📚 **[مکمل دستاویزات دیکھیں](docs/)** - GitHub پر markdown ڈاکس کو براؤز کریں

### شروعات کرنا

- **[انسٹالیشن گائیڈ](https://docs.claude-mem.ai/installation)** - تیز رفتار شروعات اور اعلیٰ درجے کی انسٹالیشن
- **[استعمال گائیڈ](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem خودکار طور پر کیسے کام کرتا ہے
- **[تلاش کے اوزار](https://docs.claude-mem.ai/usage/search-tools)** - قدرتی زبان کے ساتھ اپنے منصوبے کی تاریخ میں تلاش کریں
- **[بیٹا خصوصیات](https://docs.claude-mem.ai/beta-features)** - Endless Mode جیسی تجرباتی خصوصیات آزمائیں

### بہترین طریقہ کار

- **[تناسب انجینیئرنگ](https://docs.claude-mem.ai/context-engineering)** - AI ایجنٹ کے تناسب کی اہمیت کے اصول
- **[بتدریج ظہور](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem کے تناسب کی تیاری کی حکمت عملی کے پیچھے فلسفہ

### تعمیر

- **[جائزہ](https://docs.claude-mem.ai/architecture/overview)** - نظام کے اجزاء اور ڈیٹا کے بہاؤ
- **[تعمیر کا ارتقاء](https://docs.claude-mem.ai/architecture-evolution)** - v3 سے v5 تک کا سفر
- **[ہکس تعمیر](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem لائف سائیکل ہکس کا استعمال کیسے کرتا ہے
- **[ہکس حوالہ](https://docs.claude-mem.ai/architecture/hooks)** - 7 ہک اسکرپٹس کی تشریح
- **[ورکر سروس](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API اور Bun انتظام
- **[ڈیٹا بیس](https://docs.claude-mem.ai/architecture/database)** - SQLite اسکیما اور FTS5 تلاش
- **[تلاش تعمیر](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma ویکٹر ڈیٹا بیس کے ساتھ ہائبرڈ تلاش

### ترتیبات اور ترقی

- **[ترتیبات](https://docs.claude-mem.ai/configuration)** - ماحول کے متغیرات اور سیٹنگز
- **[ترقی](https://docs.claude-mem.ai/development)** - تعمیر، جانچ، حصہ داری
- **[مسائل کی تشخیص](https://docs.claude-mem.ai/troubleshooting)** - عام مسائل اور حل

---

## یہ کیسے کام کرتا ہے

**اہم اجزاء:**

1. **5 لائف سائیکل ہکس** - SessionStart، UserPromptSubmit، PostToolUse، Stop، SessionEnd (6 ہک اسکرپٹس)
2. **سمارٹ انسٹالیشن** - کیش شدہ منحصرات چیکر (پری ہک اسکرپٹ، لائف سائیکل ہک نہیں)
3. **ورکر سروس** - ویب ویور UI اور 10 تلاش کے endpoints کے ساتھ پورٹ 37777 پر HTTP API، Bun کے ذریعے برتاؤ
4. **SQLite ڈیٹا بیس** - سیشنز، مشاہدات، خلاصہ ذخیرہ کرتا ہے
5. **mem-search مہارت** - بتدریج ظہور کے ساتھ قدرتی زبان کے سوالات
6. **Chroma ویکٹر ڈیٹا بیس** - ہائبرڈ سیمانٹک + کلیدی لفظ تلاش ذہین تناسب کی بازیافت کے لیے

تفصیلات کے لیے [تعمیر کا جائزہ](https://docs.claude-mem.ai/architecture/overview) دیکھیں۔

---

## MCP تلاش کے اوزار

Claude-Mem ٹوکن-موثر **3-لیئر ورک فلو پیٹرن** کی پیروی کرتے ہوئے **4 MCP اوزار** کے ذریعے ذہین میموری تلاش فراہم کرتا ہے:

**3-لیئر ورک فلو:**

1. **`search`** - IDs کے ساتھ کمپیکٹ انڈیکس حاصل کریں (~50-100 ٹوکن/نتیجہ)
2. **`timeline`** - دلچسپ نتائج کے ارد گرد زمانی تناسب حاصل کریں
3. **`get_observations`** - فلٹر شدہ IDs کے لیے صرف مکمل تفصیلات حاصل کریں (~500-1,000 ٹوکن/نتیجہ)

**یہ کیسے کام کرتا ہے:**
- Claude آپ کی میموری میں تلاش کے لیے MCP اوزار استعمال کرتا ہے
- نتائج کا انڈیکس حاصل کرنے کے لیے `search` سے شروع کریں
- مخصوص مشاہدات کے ارد گرد کیا ہو رہا تھا دیکھنے کے لیے `timeline` استعمال کریں
- متعلقہ IDs کے لیے مکمل تفصیلات حاصل کرنے کے لیے `get_observations` استعمال کریں
- تفصیلات حاصل کرنے سے پہلے فلٹرنگ کے ذریعے **~10x ٹوکن کی بچت**

**دستیاب MCP اوزار:**

1. **`search`** - مکمل متن کی تلاش کے سوالات کے ساتھ میموری انڈیکس تلاش کریں، قسم/تاریخ/منصوبے کے لحاظ سے فلٹر کریں
2. **`timeline`** - مخصوص مشاہدہ یا سوال کے ارد گرد زمانی تناسب حاصل کریں
3. **`get_observations`** - IDs کے ذریعے مکمل مشاہدہ تفصیلات حاصل کریں (ہمیشہ متعدد IDs کو بیچ کریں)
4. **`__IMPORTANT`** - ورک فلو دستاویزات (ہمیشہ Claude کو نظر آتی ہے)

**استعمال کی مثال:**

```typescript
// مرحلہ 1: انڈیکس کے لیے تلاش کریں
search(query="authentication bug", type="bugfix", limit=10)

// مرحلہ 2: انڈیکس کا جائزہ لیں، متعلقہ IDs کی شناخت کریں (مثلاً، #123, #456)

// مرحلہ 3: مکمل تفصیلات حاصل کریں
get_observations(ids=[123, 456])
```

تفصیلی مثالوں کے لیے [تلاش کے اوزار گائیڈ](https://docs.claude-mem.ai/usage/search-tools) دیکھیں۔

---

## بیٹا خصوصیات

Claude-Mem ایک **بیٹا چینل** فراہم کرتا ہے جس میں **Endless Mode** جیسی تجرباتی خصوصیات ہیں (بڑھی ہوئی سیشنز کے لیے حیاتی نقل میموری کی تعمیر)۔ http://localhost:37777 → Settings میں ویب ویور UI سے مستحکم اور بیٹا ورژن کے درمیان سوئچ کریں۔

Endless Mode اور اسے کیسے آزمائیں اس کے بارے میں تفصیلات کے لیے **[بیٹا خصوصیات دستاویزات](https://docs.claude-mem.ai/beta-features)** دیکھیں۔

---

## نظام کی ضروریات

- **Node.js**: 18.0.0 یا اس سے اوپر
- **Claude Code**: پلگ ان سپورٹ کے ساتھ جدید ترین ورژن
- **Bun**: JavaScript رن ٹائم اور پروسیس مینیجر (غیر موجود ہو تو خودکار طور پر انسٹال ہوگا)
- **uv**: ویکٹر تلاش کے لیے Python پیکج مینیجر (غیر موجود ہو تو خودکار طور پر انسٹال ہوگا)
- **SQLite 3**: مستقل اسٹوریج کے لیے (بنڈل شدہ)

---

## ترتیبات

سیٹنگز `~/.claude-mem/settings.json` میں منظم ہیں (پہلی رن میں ڈیفالٹ کے ساتھ خودکار طور پر بنائی جاتی ہے)۔ AI ماڈل، ورکر پورٹ، ڈیٹا ڈائریکٹری، لاگ لیول اور تناسب انجیکشن سیٹنگز کو ترتیب دیں۔

تمام دستیاب سیٹنگز اور مثالوں کے لیے **[ترتیبات گائیڈ](https://docs.claude-mem.ai/configuration)** دیکھیں۔

---

## ترقی

تعمیر کی ہدایات، جانچ اور حصہ داری کے کام کے بہاؤ کے لیے **[ترقی گائیڈ](https://docs.claude-mem.ai/development)** دیکھیں۔

---

## مسائل کی تشخیص

اگر مسائل کا سامنا ہو تو Claude کو مسئلہ بتائیں اور troubleshoot مہارت خودکار طور پر تشخیص دے گی اور حل فراہم کرے گی۔

عام مسائل اور حل کے لیے **[مسائل کی تشخیص گائیڈ](https://docs.claude-mem.ai/troubleshooting)** دیکھیں۔

---

## خرابی کی رپورٹ

خودکار جنریٹر کے ساتھ تفصیلی خرابی کی رپورٹ تیار کریں:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## حصہ داری

حصہ داری کا خیر مقدم ہے! براہ کرم:

1. رپوزیٹری کو فورک کریں
2. ایک خصوصیت کی برانچ بنائیں
3. ٹیسٹ کے ساتھ اپنی تبدیلیاں کریں
4. دستاویزات کو اپڈیٹ کریں
5. ایک Pull Request جمع کریں

حصہ داری کے کام کے بہاؤ کے لیے [ترقی گائیڈ](https://docs.claude-mem.ai/development) دیکھیں۔

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## معاونت

- **دستاویزات**: [docs/](docs/)
- **مسائل**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **رپوزیٹری**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **مصنف**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK کے ساتھ بنایا گیا** | **Claude Code کے ذریعے طاقت ور** | **TypeScript کے ساتھ بنایا گیا**

</section>
