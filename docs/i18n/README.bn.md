🌐 এটি একটি স্বয়ংক্রিয় অনুবাদ। সম্প্রদায়ের সংশোধন স্বাগত জানাই!

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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a>-এর জন্য নির্মিত স্থায়ী মেমরি কম্প্রেশন সিস্টেম।</h4>

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
  <a href="#দ্রুত-শুরু">দ্রুত শুরু</a> •
  <a href="#এটি-কীভাবে-কাজ-করে">এটি কীভাবে কাজ করে</a> •
  <a href="#অনুসন্ধান-টুল">অনুসন্ধান টুল</a> •
  <a href="#ডকুমেন্টেশন">ডকুমেন্টেশন</a> •
  <a href="#কনফিগারেশন">কনফিগারেশন</a> •
  <a href="#সমস্যা-সমাধান">সমস্যা সমাধান</a> •
  <a href="#লাইসেন্স">লাইসেন্স</a>
</p>

<p align="center">
  Claude-Mem স্বয়ংক্রিয়ভাবে টুল ব্যবহারের পর্যবেক্ষণ ক্যাপচার করে, সিমান্টিক সারসংক্ষেপ তৈরি করে এবং সেগুলি ভবিষ্যতের সেশনে উপলব্ধ করে সেশন জুড়ে প্রসঙ্গ নির্বিঘ্নে সংরক্ষণ করে। এটি Claude কে সেশন শেষ হওয়ার বা পুনঃসংযোগের পরেও প্রকল্প সম্পর্কে জ্ঞানের ধারাবাহিকতা বজায় রাখতে সক্ষম করে।
</p>

---

## দ্রুত শুরু

টার্মিনালে একটি নতুন Claude Code সেশন শুরু করুন এবং নিম্নলিখিত কমান্ডগুলি প্রবেশ করান:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code পুনরায় চালু করুন। পূর্ববর্তী সেশনের প্রসঙ্গ স্বয়ংক্রিয়ভাবে নতুন সেশনে উপস্থিত হবে।

**মূল বৈশিষ্ট্যসমূহ:**

- 🧠 **স্থায়ী মেমরি** - প্রসঙ্গ সেশন জুড়ে টিকে থাকে
- 📊 **প্রগতিশীল প্রকাশ** - টোকেন খরচ দৃশ্যমানতা সহ স্তরযুক্ত মেমরি পুনরুদ্ধার
- 🔍 **দক্ষতা-ভিত্তিক অনুসন্ধান** - mem-search skill দিয়ে আপনার প্রকল্পের ইতিহাস অনুসন্ধান করুন
- 🖥️ **ওয়েব ভিউয়ার UI** - http://localhost:37777 এ রিয়েল-টাইম মেমরি স্ট্রিম
- 💻 **Claude Desktop Skill** - Claude Desktop কথোপকথন থেকে মেমরি অনুসন্ধান করুন
- 🔒 **গোপনীয়তা নিয়ন্ত্রণ** - সংবেদনশীল বিষয়বস্তু স্টোরেজ থেকে বাদ দিতে `<private>` ট্যাগ ব্যবহার করুন
- ⚙️ **প্রসঙ্গ কনফিগারেশন** - কোন প্রসঙ্গ ইনজেক্ট করা হবে তার উপর সূক্ষ্ম নিয়ন্ত্রণ
- 🤖 **স্বয়ংক্রিয় অপারেশন** - কোন ম্যানুয়াল হস্তক্ষেপ প্রয়োজন নেই
- 🔗 **উদ্ধৃতি** - ID দিয়ে পূর্ববর্তী পর্যবেক্ষণ রেফারেন্স করুন (http://localhost:37777/api/observation/{id} এর মাধ্যমে অ্যাক্সেস করুন অথবা http://localhost:37777 এ ওয়েব ভিউয়ারে সব দেখুন)
- 🧪 **বিটা চ্যানেল** - ভার্সন পরিবর্তনের মাধ্যমে Endless Mode-এর মতো পরীক্ষামূলক বৈশিষ্ট্য চেষ্টা করুন

---

## ডকুমেন্টেশন

📚 **[সম্পূর্ণ ডকুমেন্টেশন দেখুন](https://docs.claude-mem.ai/)** - অফিসিয়াল ওয়েবসাইটে ব্রাউজ করুন

### শুরু করা

- **[ইনস্টলেশন গাইড](https://docs.claude-mem.ai/installation)** - দ্রুত শুরু এবং উন্নত ইনস্টলেশন
- **[ব্যবহার গাইড](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem কীভাবে স্বয়ংক্রিয়ভাবে কাজ করে
- **[অনুসন্ধান টুল](https://docs.claude-mem.ai/usage/search-tools)** - প্রাকৃতিক ভাষা দিয়ে আপনার প্রকল্পের ইতিহাস অনুসন্ধান করুন
- **[বিটা বৈশিষ্ট্য](https://docs.claude-mem.ai/beta-features)** - Endless Mode-এর মতো পরীক্ষামূলক বৈশিষ্ট্য চেষ্টা করুন

### সর্বোত্তম অনুশীলন

- **[প্রসঙ্গ ইঞ্জিনিয়ারিং](https://docs.claude-mem.ai/context-engineering)** - AI এজেন্ট প্রসঙ্গ অপটিমাইজেশন নীতি
- **[প্রগতিশীল প্রকাশ](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem-এর প্রসঙ্গ প্রাইমিং কৌশলের পিছনে দর্শন

### আর্কিটেকচার

- **[সারসংক্ষেপ](https://docs.claude-mem.ai/architecture/overview)** - সিস্টেম উপাদান এবং ডেটা ফ্লো
- **[আর্কিটেকচার বিবর্তন](https://docs.claude-mem.ai/architecture-evolution)** - v3 থেকে v5 পর্যন্ত যাত্রা
- **[হুকস আর্কিটেকচার](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem কীভাবে লাইফসাইকেল হুক ব্যবহার করে
- **[হুকস রেফারেন্স](https://docs.claude-mem.ai/architecture/hooks)** - ৭টি হুক স্ক্রিপ্ট ব্যাখ্যা করা হয়েছে
- **[ওয়ার্কার সার্ভিস](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API এবং Bun ম্যানেজমেন্ট
- **[ডাটাবেস](https://docs.claude-mem.ai/architecture/database)** - SQLite স্কিমা এবং FTS5 অনুসন্ধান
- **[অনুসন্ধান আর্কিটেকচার](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma ভেক্টর ডাটাবেস সহ হাইব্রিড অনুসন্ধান

### কনফিগারেশন এবং ডেভেলপমেন্ট

- **[কনফিগারেশন](https://docs.claude-mem.ai/configuration)** - পরিবেশ ভেরিয়েবল এবং সেটিংস
- **[ডেভেলপমেন্ট](https://docs.claude-mem.ai/development)** - বিল্ডিং, টেস্টিং, অবদান
- **[সমস্যা সমাধান](https://docs.claude-mem.ai/troubleshooting)** - সাধারণ সমস্যা এবং সমাধান

---

## এটি কীভাবে কাজ করে

**মূল উপাদানসমূহ:**

1. **৫টি লাইফসাইকেল হুক** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (৬টি হুক স্ক্রিপ্ট)
2. **স্মার্ট ইনস্টল** - ক্যাশড ডিপেন্ডেন্সি চেকার (প্রি-হুক স্ক্রিপ্ট, লাইফসাইকেল হুক নয়)
3. **ওয়ার্কার সার্ভিস** - ওয়েব ভিউয়ার UI এবং ১০টি অনুসন্ধান এন্ডপয়েন্ট সহ পোর্ট 37777-এ HTTP API, Bun দ্বারা পরিচালিত
4. **SQLite ডাটাবেস** - সেশন, পর্যবেক্ষণ, সারসংক্ষেপ সংরক্ষণ করে
5. **mem-search Skill** - প্রগতিশীল প্রকাশ সহ প্রাকৃতিক ভাষা প্রশ্ন
6. **Chroma ভেক্টর ডাটাবেস** - বুদ্ধিমান প্রসঙ্গ পুনরুদ্ধারের জন্য হাইব্রিড সিমান্টিক + কীওয়ার্ড অনুসন্ধান

বিস্তারিত জানতে [আর্কিটেকচার সারসংক্ষেপ](https://docs.claude-mem.ai/architecture/overview) দেখুন।

---

## অনুসন্ধান টুল

Claude-Mem, mem-search skill-এর মাধ্যমে বুদ্ধিমান অনুসন্ধান প্রদান করে যা আপনি পূর্ববর্তী কাজ সম্পর্কে জিজ্ঞাসা করলে স্বয়ংক্রিয়ভাবে চালু হয়:

**এটি কীভাবে কাজ করে:**
- শুধু স্বাভাবিকভাবে জিজ্ঞাসা করুন: *"গত সেশনে আমরা কী করেছিলাম?"* অথবা *"আমরা কি আগে এই বাগটি ঠিক করেছিলাম?"*
- Claude স্বয়ংক্রিয়ভাবে প্রাসঙ্গিক প্রসঙ্গ খুঁজে পেতে mem-search skill চালু করে

**উপলব্ধ অনুসন্ধান অপারেশনসমূহ:**

1. **অবজারভেশন অনুসন্ধান করুন** - পর্যবেক্ষণ জুড়ে পূর্ণ-পাঠ্য অনুসন্ধান
2. **সেশন অনুসন্ধান করুন** - সেশন সারসংক্ষেপ জুড়ে পূর্ণ-পাঠ্য অনুসন্ধান
3. **প্রম্পট অনুসন্ধান করুন** - কাঁচা ব্যবহারকারী অনুরোধ অনুসন্ধান করুন
4. **ধারণা অনুযায়ী** - ধারণা ট্যাগ দ্বারা খুঁজুন (discovery, problem-solution, pattern, ইত্যাদি)
5. **ফাইল অনুযায়ী** - নির্দিষ্ট ফাইল উল্লেখ করা পর্যবেক্ষণ খুঁজুন
6. **টাইপ অনুযায়ী** - টাইপ দ্বারা খুঁজুন (decision, bugfix, feature, refactor, discovery, change)
7. **সাম্প্রতিক প্রসঙ্গ** - একটি প্রকল্পের জন্য সাম্প্রতিক সেশন প্রসঙ্গ পান
8. **টাইমলাইন** - সময়ের একটি নির্দিষ্ট বিন্দুর চারপাশে প্রসঙ্গের একীভূত টাইমলাইন পান
9. **প্রশ্ন দ্বারা টাইমলাইন** - পর্যবেক্ষণ অনুসন্ধান করুন এবং সেরা মিলের চারপাশে টাইমলাইন প্রসঙ্গ পান
10. **API সহায়তা** - অনুসন্ধান API ডকুমেন্টেশন পান

**প্রাকৃতিক ভাষা প্রশ্নের উদাহরণ:**

```
"গত সেশনে আমরা কোন বাগ ঠিক করেছিলাম?"
"আমরা কীভাবে অথেন্টিকেশন প্রয়োগ করেছি?"
"worker-service.ts-এ কী পরিবর্তন করা হয়েছিল?"
"এই প্রকল্পে সাম্প্রতিক কাজ দেখান"
"ভিউয়ার UI যোগ করার সময় কী হচ্ছিল?"
```

বিস্তারিত উদাহরণের জন্য [অনুসন্ধান টুল গাইড](https://docs.claude-mem.ai/usage/search-tools) দেখুন।

---

## বিটা বৈশিষ্ট্য

Claude-Mem একটি **বিটা চ্যানেল** অফার করে যাতে **Endless Mode**-এর মতো পরীক্ষামূলক বৈশিষ্ট্য রয়েছে (বর্ধিত সেশনের জন্য বায়োমিমেটিক মেমরি আর্কিটেকচার)। http://localhost:37777 → Settings-এ ওয়েব ভিউয়ার UI থেকে স্থিতিশীল এবং বিটা সংস্করণের মধ্যে স্যুইচ করুন।

Endless Mode এবং এটি কীভাবে চেষ্টা করবেন সে সম্পর্কে বিস্তারিত জানতে **[বিটা বৈশিষ্ট্য ডকুমেন্টেশন](https://docs.claude-mem.ai/beta-features)** দেখুন।

---

## সিস্টেম প্রয়োজনীয়তা

- **Node.js**: 18.0.0 বা উচ্চতর
- **Claude Code**: প্লাগইন সাপোর্ট সহ সর্বশেষ সংস্করণ
- **Bun**: JavaScript রানটাইম এবং প্রসেস ম্যানেজার (অনুপস্থিত থাকলে স্বয়ংক্রিয়ভাবে ইনস্টল হয়)
- **uv**: ভেক্টর অনুসন্ধানের জন্য Python প্যাকেজ ম্যানেজার (অনুপস্থিত থাকলে স্বয়ংক্রিয়ভাবে ইনস্টল হয়)
- **SQLite 3**: স্থায়ী স্টোরেজের জন্য (বান্ডল করা)

---

## কনফিগারেশন

সেটিংস `~/.claude-mem/settings.json`-এ পরিচালিত হয় (প্রথম রানে ডিফল্ট সহ স্বয়ংক্রিয়ভাবে তৈরি হয়)। AI মডেল, ওয়ার্কার পোর্ট, ডেটা ডিরেক্টরি, লগ লেভেল এবং প্রসঙ্গ ইনজেকশন সেটিংস কনফিগার করুন।

সমস্ত উপলব্ধ সেটিংস এবং উদাহরণের জন্য **[কনফিগারেশন গাইড](https://docs.claude-mem.ai/configuration)** দেখুন।

---

## ডেভেলপমেন্ট

বিল্ড নির্দেশাবলী, টেস্টিং এবং অবদান ওয়ার্কফ্লোর জন্য **[ডেভেলপমেন্ট গাইড](https://docs.claude-mem.ai/development)** দেখুন।

---

## সমস্যা সমাধান

যদি সমস্যার সম্মুখীন হন, Claude-কে সমস্যাটি বর্ণনা করুন এবং troubleshoot skill স্বয়ংক্রিয়ভাবে নির্ণয় করবে এবং সমাধান প্রদান করবে।

সাধারণ সমস্যা এবং সমাধানের জন্য **[সমস্যা সমাধান গাইড](https://docs.claude-mem.ai/troubleshooting)** দেখুন।

---

## বাগ রিপোর্ট

স্বয়ংক্রিয় জেনারেটর দিয়ে বিস্তৃত বাগ রিপোর্ট তৈরি করুন:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## অবদান

অবদান স্বাগত জানাই! অনুগ্রহ করে:

1. রিপোজিটরি ফর্ক করুন
2. একটি ফিচার ব্র্যাঞ্চ তৈরি করুন
3. টেস্ট সহ আপনার পরিবর্তনগুলি করুন
4. ডকুমেন্টেশন আপডেট করুন
5. একটি Pull Request জমা দিন

অবদান ওয়ার্কফ্লোর জন্য [ডেভেলপমেন্ট গাইড](https://docs.claude-mem.ai/development) দেখুন।

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## সাপোর্ট

- **ডকুমেন্টেশন**: [docs/](docs/)
- **ইস্যু**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **রিপোজিটরি**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **লেখক**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK দিয়ে নির্মিত** | **Claude Code দ্বারা চালিত** | **TypeScript দিয়ে তৈরি**