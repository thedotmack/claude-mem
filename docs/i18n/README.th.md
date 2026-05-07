🌐 นี่คือการแปลอัตโนมัติ ยินดีต้อนรับการแก้ไขจากชุมชน!

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

<h4 align="center">ระบบการบีบอัดหน่วยความจำถาวรที่สร้างขึ้นสำหรับ <a href="https://claude.com/claude-code" target="_blank">Claude Code</a></h4>

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
  <a href="#quick-start">เริ่มต้นอย่างรวดเร็ว</a> •
  <a href="#how-it-works">วิธีการทำงาน</a> •
  <a href="#mcp-search-tools">เครื่องมือค้นหา</a> •
  <a href="#documentation">เอกสาร</a> •
  <a href="#configuration">การกำหนดค่า</a> •
  <a href="#troubleshooting">การแก้ไขปัญหา</a> •
  <a href="#license">ใบอนุญาต</a>
</p>

<p align="center">
  Claude-Mem รักษาบริบทข้ามเซสชันได้อย่างราบรื่นโดยการบันทึกผลการสังเกตจากการใช้เครื่องมือโดยอัตโนมัติ สร้างสรุปความหมาย และทำให้พร้อมใช้งานสำหรับเซสชันในอนาคต ทำให้ Claude สามารถรักษาความต่อเนื่องของความรู้เกี่ยวกับโปรเจกต์แม้หลังจากเซสชันสิ้นสุดหรือเชื่อมต่อใหม่
</p>

---

## เริ่มต้นอย่างรวดเร็ว

เริ่มเซสชัน Claude Code ใหม่ในเทอร์มินัลและป้อนคำสั่งต่อไปนี้:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

รีสตาร์ท Claude Code บริบทจากเซสชันก่อนหน้าจะปรากฏในเซสชันใหม่โดยอัตโนมัติ

**คุณสมบัติหลัก:**

- 🧠 **หน่วยความจำถาวร** - บริบทยังคงอยู่ข้ามเซสชัน
- 📊 **การเปิดเผยแบบก้าวหน้า** - การดึงหน่วยความจำแบบชั้นพร้อมการแสดงต้นทุนโทเค็น
- 🔍 **การค้นหาตามทักษะ** - สืบค้นประวัติโปรเจกต์ของคุณด้วยทักษะ mem-search
- 🖥️ **Web Viewer UI** - สตรีมหน่วยความจำแบบเรียลไทม์ที่ http://localhost:37777
- 💻 **Claude Desktop Skill** - ค้นหาหน่วยความจำจากการสนทนา Claude Desktop
- 🔒 **การควบคุมความเป็นส่วนตัว** - ใช้แท็ก `<private>` เพื่อยกเว้นเนื้อหาที่ละเอียดอ่อนจากการจัดเก็บ
- ⚙️ **การกำหนดค่าบริบท** - ควบคุมบริบทที่ถูกฉีดเข้ามาได้อย่างละเอียด
- 🤖 **การทำงานอัตโนมัติ** - ไม่ต้องแทรกแซงด้วยตนเอง
- 🔗 **การอ้างอิง** - อ้างอิงการสังเกตในอดีตด้วย ID (เข้าถึงผ่าน http://localhost:37777/api/observation/{id} หรือดูทั้งหมดใน web viewer ที่ http://localhost:37777)
- 🧪 **Beta Channel** - ลองคุณสมบัติทดลองเช่น Endless Mode ผ่านการสลับเวอร์ชัน

---

## เอกสาร

📚 **[ดูเอกสารฉบับเต็ม](https://docs.claude-mem.ai/)** - เรียกดูบนเว็บไซต์อย่างเป็นทางการ

### เริ่มต้นใช้งาน

- **[คู่มือการติดตั้ง](https://docs.claude-mem.ai/installation)** - เริ่มต้นอย่างรวดเร็วและการติดตั้งขั้นสูง
- **[คู่มือการใช้งาน](https://docs.claude-mem.ai/usage/getting-started)** - วิธีที่ Claude-Mem ทำงานโดยอัตโนมัติ
- **[เครื่องมือค้นหา](https://docs.claude-mem.ai/usage/search-tools)** - สืบค้นประวัติโปรเจกต์ของคุณด้วยภาษาธรรมชาติ
- **[คุณสมบัติ Beta](https://docs.claude-mem.ai/beta-features)** - ลองคุณสมบัติทดลองเช่น Endless Mode

### แนวปฏิบัติที่ดี

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - หลักการปรับบริบทสำหรับเอเจนต์ AI
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - ปรัชญาเบื้องหลังกลยุทธ์การเตรียมบริบทของ Claude-Mem

### สถาปัตยกรรม

- **[ภาพรวม](https://docs.claude-mem.ai/architecture/overview)** - ส่วนประกอบของระบบและการไหลของข้อมูล
- **[วิวัฒนาการของสถาปัตยกรรม](https://docs.claude-mem.ai/architecture-evolution)** - การเดินทางจาก v3 สู่ v5
- **[สถาปัตยกรรม Hooks](https://docs.claude-mem.ai/hooks-architecture)** - วิธีที่ Claude-Mem ใช้ lifecycle hooks
- **[การอ้างอิง Hooks](https://docs.claude-mem.ai/architecture/hooks)** - อธิบาย hook scripts ทั้ง 7 ตัว
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API และการจัดการ Bun
- **[ฐานข้อมูล](https://docs.claude-mem.ai/architecture/database)** - SQLite schema และการค้นหา FTS5
- **[สถาปัตยกรรมการค้นหา](https://docs.claude-mem.ai/architecture/search-architecture)** - การค้นหาแบบไฮบริดด้วยฐานข้อมูลเวกเตอร์ Chroma

### การกำหนดค่าและการพัฒนา

- **[การกำหนดค่า](https://docs.claude-mem.ai/configuration)** - ตัวแปรสภาพแวดล้อมและการตั้งค่า
- **[การพัฒนา](https://docs.claude-mem.ai/development)** - การสร้าง การทดสอบ การมีส่วนร่วม
- **[การแก้ไขปัญหา](https://docs.claude-mem.ai/troubleshooting)** - ปัญหาและการแก้ไขทั่วไป

---

## วิธีการทำงาน

**ส่วนประกอบหลัก:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Smart Install** - ตัวตรวจสอบการพึ่งพาที่ถูกแคช (pre-hook script, ไม่ใช่ lifecycle hook)
3. **Worker Service** - HTTP API บนพอร์ต 37777 พร้อม web viewer UI และ 10 search endpoints, จัดการโดย Bun
4. **SQLite Database** - จัดเก็บเซสชัน การสังเกต สรุป
5. **mem-search Skill** - คิวรีภาษาธรรมชาติพร้อมการเปิดเผยแบบก้าวหน้า
6. **Chroma Vector Database** - การค้นหาแบบไฮบริดทางความหมาย + คีย์เวิร์ดสำหรับการดึงบริบทอัจฉริยะ

ดู [ภาพรวมสถาปัตยกรรม](https://docs.claude-mem.ai/architecture/overview) สำหรับรายละเอียด

---

## ทักษะ mem-search

Claude-Mem ให้บริการการค้นหาอัจฉริยะผ่านทักษะ mem-search ที่เรียกใช้อัตโนมัติเมื่อคุณถามเกี่ยวกับงานที่ผ่านมา:

**วิธีการทำงาน:**
- เพียงถามตามธรรมชาติ: *"เราทำอะไรในเซสชันที่แล้ว?"* หรือ *"เราแก้บั๊กนี้ไปแล้วหรือยัง?"*
- Claude เรียกใช้ทักษะ mem-search โดยอัตโนมัติเพื่อค้นหาบริบทที่เกี่ยวข้อง

**การดำเนินการค้นหาที่มี:**

1. **Search Observations** - การค้นหาข้อความเต็มข้ามการสังเกต
2. **Search Sessions** - การค้นหาข้อความเต็มข้ามสรุปเซสชัน
3. **Search Prompts** - ค้นหาคำขอผู้ใช้แบบดิบ
4. **By Concept** - ค้นหาตามแท็กแนวคิด (discovery, problem-solution, pattern, ฯลฯ)
5. **By File** - ค้นหาการสังเกตที่อ้างอิงไฟล์เฉพาะ
6. **By Type** - ค้นหาตามประเภท (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - รับบริบทเซสชันล่าสุดสำหรับโปรเจกต์
8. **Timeline** - รับไทม์ไลน์รวมของบริบทรอบจุดเวลาเฉพาะ
9. **Timeline by Query** - ค้นหาการสังเกตและรับบริบทไทม์ไลน์รอบการจับคู่ที่ดีที่สุด
10. **API Help** - รับเอกสาร search API

**ตัวอย่างคิวรีภาษาธรรมชาติ:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

ดู [คู่มือเครื่องมือค้นหา](https://docs.claude-mem.ai/usage/search-tools) สำหรับตัวอย่างโดยละเอียด

---

## คุณสมบัติ Beta

Claude-Mem นำเสนอ **beta channel** พร้อมคุณสมบัติทดลองเช่น **Endless Mode** (สถาปัตยกรรมหน่วยความจำแบบชีวมิติสำหรับเซสชันที่ขยายออกไป) สลับระหว่างเวอร์ชันเสถียรและเบต้าจาก web viewer UI ที่ http://localhost:37777 → Settings

ดู **[เอกสารคุณสมบัติ Beta](https://docs.claude-mem.ai/beta-features)** สำหรับรายละเอียดเกี่ยวกับ Endless Mode และวิธีการลอง

---

## ความต้องการของระบบ

- **Node.js**: 18.0.0 หรือสูงกว่า
- **Claude Code**: เวอร์ชันล่าสุดพร้อมการสนับสนุนปลั๊กอิน
- **Bun**: JavaScript runtime และตัวจัดการกระบวนการ (ติดตั้งอัตโนมัติหากไม่มี)
- **uv**: ตัวจัดการแพ็คเกจ Python สำหรับการค้นหาเวกเตอร์ (ติดตั้งอัตโนมัติหากไม่มี)
- **SQLite 3**: สำหรับการจัดเก็บถาวร (รวมอยู่)

---

## การกำหนดค่า

การตั้งค่าจะถูกจัดการใน `~/.claude-mem/settings.json` (สร้างอัตโนมัติพร้อมค่าเริ่มต้นในการรันครั้งแรก) กำหนดค่าโมเดล AI พอร์ต worker ไดเรกทอรีข้อมูล ระดับ log และการตั้งค่าการฉีดบริบท

ดู **[คู่มือการกำหนดค่า](https://docs.claude-mem.ai/configuration)** สำหรับการตั้งค่าทั้งหมดที่มีและตัวอย่าง

---

## การพัฒนา

ดู **[คู่มือการพัฒนา](https://docs.claude-mem.ai/development)** สำหรับคำแนะนำการสร้าง การทดสอบ และขั้นตอนการมีส่วนร่วม

---

## การแก้ไขปัญหา

หากพบปัญหา อธิบายปัญหาให้ Claude ฟังและทักษะ troubleshoot จะวินิจฉัยและให้การแก้ไขโดยอัตโนมัติ

ดู **[คู่มือการแก้ไขปัญหา](https://docs.claude-mem.ai/troubleshooting)** สำหรับปัญหาและการแก้ไขทั่วไป

---

## รายงานบั๊ก

สร้างรายงานบั๊กที่ครอบคลุมด้วยตัวสร้างอัตโนมัติ:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## การมีส่วนร่วม

ยินดีรับการมีส่วนร่วม! กรุณา:

1. Fork repository
2. สร้าง feature branch
3. ทำการเปลี่ยนแปลงพร้อมการทดสอบ
4. อัปเดตเอกสาร
5. ส่ง Pull Request

ดู [คู่มือการพัฒนา](https://docs.claude-mem.ai/development) สำหรับขั้นตอนการมีส่วนร่วม

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## การสนับสนุน

- **เอกสาร**: [docs/](docs/)
- **ปัญหา**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **ผู้เขียน**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**สร้างด้วย Claude Agent SDK** | **ขับเคลื่อนโดย Claude Code** | **สร้างด้วย TypeScript**