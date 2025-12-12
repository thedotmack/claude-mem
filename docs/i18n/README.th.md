🌐 นี่คือการแปลอัตโนมัติ ยินดีรับการแก้ไขจากชุมชน!

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

<h4 align="center">ระบบบีบอัดหน่วยความจำแบบถาวรที่สร้างขึ้นสำหรับ <a href="https://claude.com/claude-code" target="_blank">Claude Code</a></h4>

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
  <a href="#เริ่มต้นอย่างรวดเร็ว">เริ่มต้นอย่างรวดเร็ว</a> •
  <a href="#วิธีการทำงาน">วิธีการทำงาน</a> •
  <a href="#เครื่องมือค้นหา-mcp">เครื่องมือค้นหา</a> •
  <a href="#เอกสารประกอบ">เอกสารประกอบ</a> •
  <a href="#การกำหนดค่า">การกำหนดค่า</a> •
  <a href="#การแก้ไขปัญหา">การแก้ไขปัญหา</a> •
  <a href="#ลิขสิทธิ์">ลิขสิทธิ์</a>
</p>

<p align="center">
  Claude-Mem รักษาบริบทข้ามเซสชันได้อย่างราบรื่นโดยการจับภาพการสังเกตการณ์การใช้เครื่องมือโดยอัตโนมัติ สร้างสรุปเชิงความหมาย และทำให้พร้อมใช้งานสำหรับเซสชันในอนาคต ช่วยให้ Claude สามารถรักษาความต่อเนื่องของความรู้เกี่ยวกับโปรเจกต์ได้แม้หลังจากเซสชันสิ้นสุดหรือเชื่อมต่อใหม่
</p>

---

## เริ่มต้นอย่างรวดเร็ว

เริ่มเซสชัน Claude Code ใหม่ในเทอร์มินัลและใส่คำสั่งต่อไปนี้:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

รีสตาร์ท Claude Code บริบทจากเซสชันก่อนหน้าจะปรากฏอัตโนมัติในเซสชันใหม่

**ฟีเจอร์สำคัญ:**

- 🧠 **หน่วยความจำแบบถาวร** - บริบทคงอยู่ข้ามเซสชัน
- 📊 **การเปิดเผยแบบก้าวหน้า** - การดึงหน่วยความจำแบบชั้นพร้อมการแสดงต้นทุนโทเค็น
- 🔍 **การค้นหาตามสคิล** - สอบถามประวัติโปรเจกต์ของคุณด้วย mem-search skill (~ประหยัด 2,250 โทเค็น)
- 🖥️ **เว็บ Viewer UI** - สตรีมหน่วยความจำแบบเรียลไทม์ที่ http://localhost:37777
- 🔒 **การควบคุมความเป็นส่วนตัว** - ใช้แท็ก `<private>` เพื่อยกเว้นเนื้อหาที่ละเอียดอ่อนจากการจัดเก็บ
- ⚙️ **การกำหนดค่าบริบท** - ควบคุมอย่างละเอียดว่าบริบทใดจะถูกฉีดเข้าไป
- 🤖 **การทำงานอัตโนมัติ** - ไม่ต้องแทรกแซงด้วยตนเอง
- 🔗 **การอ้างอิง** - อ้างอิงการตัดสินใจในอดีตด้วย URI `claude-mem://`
- 🧪 **ช่อง Beta** - ลองฟีเจอร์ทดลองเช่น Endless Mode ผ่านการสลับเวอร์ชัน

---

## เอกสารประกอบ

📚 **[ดูเอกสารฉบับเต็ม](docs/)** - เรียกดูเอกสาร markdown บน GitHub

💻 **ดูตัวอย่างในเครื่อง**: รัน Mintlify docs ในเครื่อง:

```bash
cd docs
npx mintlify dev
```

### การเริ่มต้นใช้งาน

- **[คู่มือการติดตั้ง](https://docs.claude-mem.ai/installation)** - เริ่มต้นอย่างรวดเร็วและการติดตั้งขั้นสูง
- **[คู่มือการใช้งาน](https://docs.claude-mem.ai/usage/getting-started)** - วิธีที่ Claude-Mem ทำงานโดยอัตโนมัติ
- **[เครื่องมือค้นหา](https://docs.claude-mem.ai/usage/search-tools)** - สอบถามประวัติโปรเจกต์ของคุณด้วยภาษาธรรมชาติ
- **[ฟีเจอร์ Beta](https://docs.claude-mem.ai/beta-features)** - ลองฟีเจอร์ทดลองเช่น Endless Mode

### แนวปฏิบัติที่ดีที่สุด

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - หลักการเพิ่มประสิทธิภาพบริบทสำหรับ AI agent
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - ปรัชญาเบื้องหลังกลยุทธ์การเตรียมบริบทของ Claude-Mem

### สถาปัตยกรรม

- **[ภาพรวม](https://docs.claude-mem.ai/architecture/overview)** - ส่วนประกอบของระบบและการไหลของข้อมูล
- **[วิวัฒนาการของสถาปัตยกรรม](https://docs.claude-mem.ai/architecture-evolution)** - การเดินทางจาก v3 ถึง v5
- **[สถาปัตยกรรม Hooks](https://docs.claude-mem.ai/hooks-architecture)** - วิธีที่ Claude-Mem ใช้ lifecycle hooks
- **[ข้อมูลอ้างอิง Hooks](https://docs.claude-mem.ai/architecture/hooks)** - คำอธิบาย hook scripts ทั้ง 7 ตัว
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API และการจัดการ PM2
- **[ฐานข้อมูล](https://docs.claude-mem.ai/architecture/database)** - SQLite schema และการค้นหา FTS5
- **[สถาปัตยกรรมการค้นหา](https://docs.claude-mem.ai/architecture/search-architecture)** - การค้นหาแบบไฮบริดด้วยฐานข้อมูลเวกเตอร์ Chroma

### การกำหนดค่าและการพัฒนา

- **[การกำหนดค่า](https://docs.claude-mem.ai/configuration)** - ตัวแปรสภาพแวดล้อมและการตั้งค่า
- **[การพัฒนา](https://docs.claude-mem.ai/development)** - การสร้าง การทดสอบ การมีส่วนร่วม
- **[การแก้ไขปัญหา](https://docs.claude-mem.ai/troubleshooting)** - ปัญหาทั่วไปและวิธีแก้ไข

---

## วิธีการทำงาน

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start → ฉีดการสังเกตการณ์ล่าสุดเป็นบริบท          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ User Prompts → สร้างเซสชัน บันทึกคำสั่งของผู้ใช้           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tool Executions → จับภาพการสังเกตการณ์ (Read, Write, ฯลฯ)  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker Processes → สกัดการเรียนรู้ผ่าน Claude Agent SDK     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Session Ends → สร้างสรุป พร้อมสำหรับเซสชันถัดไป             │
└─────────────────────────────────────────────────────────────┘
```

**ส่วนประกอบหลัก:**

1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook scripts)
2. **Smart Install** - ตัวตรวจสอบ dependency แบบแคช (pre-hook script ไม่ใช่ lifecycle hook)
3. **Worker Service** - HTTP API บนพอร์ต 37777 พร้อม web viewer UI และ 10 search endpoints จัดการโดย PM2
4. **SQLite Database** - จัดเก็บเซสชัน การสังเกตการณ์ สรุปพร้อมการค้นหาข้อความแบบเต็มรูปแบบ FTS5
5. **mem-search Skill** - คิวรีภาษาธรรมชาติพร้อมการเปิดเผยแบบก้าวหน้า (~ประหยัด 2,250 โทเค็นเทียบกับ MCP)
6. **Chroma Vector Database** - การค้นหาแบบไฮบริดระหว่างความหมายและคีย์เวิร์ดสำหรับการดึงบริบทอัจฉริยะ

ดู [ภาพรวมสถาปัตยกรรม](https://docs.claude-mem.ai/architecture/overview) สำหรับรายละเอียด

---

## mem-search Skill

Claude-Mem ให้บริการการค้นหาอัจฉริยะผ่าน mem-search skill ที่เรียกใช้อัตโนมัติเมื่อคุณถามเกี่ยวกับงานในอดีต:

**วิธีการทำงาน:**
- เพียงถามตามธรรมชาติ: *"เราทำอะไรเซสชันที่แล้ว?"* หรือ *"เราเคยแก้บั๊กนี้มาก่อนไหม?"*
- Claude เรียกใช้ mem-search skill โดยอัตโนมัติเพื่อค้นหาบริบทที่เกี่ยวข้อง
- ~ประหยัด 2,250 โทเค็นต่อการเริ่มเซสชันเทียบกับแนวทาง MCP

**การดำเนินการค้นหาที่มี:**

1. **Search Observations** - ค้นหาข้อความแบบเต็มรูปแบบข้ามการสังเกตการณ์
2. **Search Sessions** - ค้นหาข้อความแบบเต็มรูปแบบข้ามสรุปเซสชัน
3. **Search Prompts** - ค้นหาคำขอดิบของผู้ใช้
4. **By Concept** - ค้นหาตามแท็กแนวคิด (discovery, problem-solution, pattern, ฯลฯ)
5. **By File** - ค้นหาการสังเกตการณ์ที่อ้างอิงไฟล์เฉพาะ
6. **By Type** - ค้นหาตามประเภท (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - รับบริบทเซสชันล่าสุดสำหรับโปรเจกต์
8. **Timeline** - รับไทม์ไลน์รวมของบริบทรอบจุดเฉพาะในเวลา
9. **Timeline by Query** - ค้นหาการสังเกตการณ์และรับบริบทไทม์ไลน์รอบการจับคู่ที่ดีที่สุด
10. **API Help** - รับเอกสาร search API

**ตัวอย่างการสอบถามภาษาธรรมชาติ:**

```
"เราแก้บั๊กอะไรบ้างเซสชันที่แล้ว?"
"เราทำ authentication ยังไง?"
"มีการเปลี่ยนแปลงอะไรบ้างใน worker-service.ts?"
"แสดงงานล่าสุดในโปรเจกต์นี้"
"เกิดอะไรขึ้นเมื่อเราเพิ่ม viewer UI?"
```

ดู [คู่มือเครื่องมือค้นหา](https://docs.claude-mem.ai/usage/search-tools) สำหรับตัวอย่างโดยละเอียด

---

## ฟีเจอร์ Beta และ Endless Mode

Claude-Mem เสนอ **ช่อง beta** พร้อมฟีเจอร์ทดลอง สลับระหว่างเวอร์ชันเสถียรและ beta ได้โดยตรงจาก web viewer UI

### วิธีลอง Beta

1. เปิด http://localhost:37777
2. คลิก Settings (ไอคอนเกียร์)
3. ใน **Version Channel** คลิก "Try Beta (Endless Mode)"
4. รอให้ worker รีสตาร์ท

ข้อมูลหน่วยความจำของคุณจะถูกเก็บไว้เมื่อสลับเวอร์ชัน

### Endless Mode (Beta)

ฟีเจอร์ beta หลักคือ **Endless Mode** - สถาปัตยกรรมหน่วยความจำแบบชีวภาพที่ขยายความยาวเซสชันอย่างมาก:

**ปัญหา**: เซสชัน Claude Code มาตรฐานถึงขีดจำกัดบริบทหลังจาก ~50 การใช้เครื่องมือ เครื่องมือแต่ละตัวเพิ่ม 1-10k+ โทเค็น และ Claude สังเคราะห์เอาต์พุตก่อนหน้าทั้งหมดใหม่ในทุกการตอบสนอง (ความซับซ้อน O(N²))

**วิธีแก้**: Endless Mode บีบอัดเอาต์พุตเครื่องมือเป็นการสังเกตการณ์ ~500 โทเค็นและแปลงทรานสคริปต์แบบเรียลไทม์:

```
Working Memory (Context):     การสังเกตการณ์ที่บีบอัด (~500 โทเค็นต่อรายการ)
Archive Memory (Disk):        เอาต์พุตเครื่องมือเต็มรูปแบบถูกเก็บไว้สำหรับเรียกคืน
```

**ผลลัพธ์ที่คาดหวัง**:
- ~ลดโทเค็นในหน้าต่างบริบทลง 95%
- ~การใช้เครื่องมือมากขึ้น 20 เท่าก่อนหมดบริบท
- การปรับขนาดเชิงเส้น O(N) แทนที่จะเป็นกำลังสอง O(N²)
- ทรานสคริปต์เต็มรูปแบบถูกเก็บไว้สำหรับการเรียกคืนที่สมบูรณ์แบบ

**ข้อควรระวัง**: เพิ่มความหน่วง (60-90 วินาทีต่อเครื่องมือสำหรับการสร้างการสังเกตการณ์) ยังคงอยู่ในช่วงทดลอง

ดู [เอกสารฟีเจอร์ Beta](https://docs.claude-mem.ai/beta-features) สำหรับรายละเอียด

---

## มีอะไรใหม่

**v6.4.9 - การตั้งค่าการกำหนดค่าบริบท:**
- การตั้งค่าใหม่ 11 รายการสำหรับการควบคุมอย่างละเอียดเกี่ยวกับการฉีดบริบท
- กำหนดค่าการแสดงผลทางเศรษฐศาสตร์โทเค็น การกรองการสังเกตการณ์ตามประเภท/แนวคิด
- ควบคุมจำนวนการสังเกตการณ์และฟิลด์ที่จะแสดง

**v6.4.0 - ระบบความเป็นส่วนตัวแบบสองแท็ก:**
- แท็ก `<private>` สำหรับความเป็นส่วนตัวที่ผู้ใช้ควบคุม - ห่อเนื้อหาที่ละเอียดอ่อนเพื่อยกเว้นจากการจัดเก็บ
- แท็ก `<claude-mem-context>` ระดับระบบป้องกันการจัดเก็บการสังเกตการณ์แบบเรียกซ้ำ
- การประมวลผลขอบทำให้มั่นใจว่าเนื้อหาส่วนตัวไม่มีทางถึงฐานข้อมูล

**v6.3.0 - ช่องเวอร์ชัน:**
- สลับระหว่างเวอร์ชันเสถียรและ beta จาก web viewer UI
- ลองฟีเจอร์ทดลองเช่น Endless Mode โดยไม่ต้องทำการดำเนินการ git ด้วยตนเอง

**ไฮไลท์ก่อนหน้า:**
- **v6.0.0**: การปรับปรุงการจัดการเซสชันและการประมวลผลทรานสคริปต์ครั้งใหญ่
- **v5.5.0**: การปรับปรุง mem-search skill ด้วยอัตราประสิทธิผล 100%
- **v5.4.0**: สถาปัตยกรรมการค้นหาแบบ skill (~ประหยัด 2,250 โทเค็นต่อเซสชัน)
- **v5.1.0**: Web-based viewer UI พร้อมอัปเดตแบบเรียลไทม์
- **v5.0.0**: การค้นหาแบบไฮบริดด้วยฐานข้อมูลเวกเตอร์ Chroma

ดู [CHANGELOG.md](CHANGELOG.md) สำหรับประวัติเวอร์ชันที่สมบูรณ์

---

## ความต้องการของระบบ

- **Node.js**: 18.0.0 หรือสูงกว่า
- **Claude Code**: เวอร์ชันล่าสุดพร้อมการสนับสนุนปลั๊กอิน
- **PM2**: ตัวจัดการกระบวนการ (มาพร้อม - ไม่ต้องติดตั้งแบบ global)
- **SQLite 3**: สำหรับพื้นที่จัดเก็บแบบถาวร (มาพร้อม)

---

## ประโยชน์หลัก

### บริบทการเปิดเผยแบบก้าวหน้า

- **การดึงหน่วยความจำแบบชั้น** สะท้อนรูปแบบหน่วยความจำของมนุษย์
- **ชั้นที่ 1 (ดัชนี)**: ดูว่ามีการสังเกตการณ์ใดบ้างพร้อมต้นทุนโทเค็นเมื่อเริ่มเซสชัน
- **ชั้นที่ 2 (รายละเอียด)**: ดึงเรื่องราวเต็มรูปแบบตามต้องการผ่าน MCP search
- **ชั้นที่ 3 (การเรียกคืนที่สมบูรณ์แบบ)**: เข้าถึงซอร์สโค้ดและทรานสคริปต์ต้นฉบับ
- **การตัดสินใจอัจฉริยะ**: จำนวนโทเค็นช่วยให้ Claude เลือกระหว่างการดึงรายละเอียดหรืออ่านโค้ด
- **ตัวบ่งชี้ประเภท**: สัญลักษณ์ภาพ (🔴 สำคัญ, 🟤 การตัดสินใจ, 🔵 ข้อมูล) เน้นความสำคัญของการสังเกตการณ์

### หน่วยความจำอัตโนมัติ

- บริบทถูกฉีดเข้าไปโดยอัตโนมัติเมื่อ Claude เริ่มต้น
- ไม่ต้องใช้คำสั่งหรือการกำหนดค่าด้วยตนเอง
- ทำงานอย่างโปร่งใสในพื้นหลัง

### การค้นหาประวัติแบบเต็มรูปแบบ

- ค้นหาข้ามเซสชันและการสังเกตการณ์ทั้งหมด
- การค้นหาข้อความแบบเต็มรูปแบบ FTS5 สำหรับคิวรีที่เร็ว
- การอ้างอิงเชื่อมโยงกลับไปยังการสังเกตการณ์เฉพาะ

### การสังเกตการณ์ที่มีโครงสร้าง

- การสกัดการเรียนรู้ที่ขับเคลื่อนด้วย AI
- จัดหมวดหมู่ตามประเภท (decision, bugfix, feature, ฯลฯ)
- แท็กด้วยแนวคิดและการอ้างอิงไฟล์

### เซสชันหลายคำสั่ง

- เซสชันครอบคลุมคำสั่งของผู้ใช้หลายรายการ
- บริบทถูกเก็บรักษาไว้ข้ามคำสั่ง `/clear`
- ติดตามเธรดการสนทนาทั้งหมด

---

## การกำหนดค่า

การตั้งค่าจัดการใน `~/.claude-mem/settings.json` ไฟล์ถูกสร้างอัตโนมัติพร้อมค่าเริ่มต้นเมื่อรันครั้งแรก

**การตั้งค่าที่มี:**

| การตั้งค่า | ค่าเริ่มต้น | คำอธิบาย |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | โมเดล AI สำหรับการสังเกตการณ์ |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | พอร์ต Worker service |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | ตำแหน่งไดเรกทอรีข้อมูล |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | ความละเอียดของล็อก (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | เวอร์ชัน Python สำหรับ chroma-mcp |
| `CLAUDE_CODE_PATH` | _(ตรวจจับอัตโนมัติ)_ | เส้นทางไปยัง Claude executable |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | จำนวนการสังเกตการณ์ที่จะฉีดเข้าไปที่ SessionStart |

**การจัดการการตั้งค่า:**

```bash
# แก้ไขการตั้งค่าผ่าน CLI helper
./claude-mem-settings.sh

# หรือแก้ไขโดยตรง
nano ~/.claude-mem/settings.json

# ดูการตั้งค่าปัจจุบัน
curl http://localhost:37777/api/settings
```

**รูปแบบไฟล์การตั้งค่า:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

ดู [คู่มือการกำหนดค่า](https://docs.claude-mem.ai/configuration) สำหรับรายละเอียด

---

## การพัฒนา

```bash
# โคลนและสร้าง
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# รันการทดสอบ
npm test

# เริ่ม worker
npm run worker:start

# ดูล็อก
npm run worker:logs
```

ดู [คู่มือการพัฒนา](https://docs.claude-mem.ai/development) สำหรับคำแนะนำโดยละเอียด

---

## การแก้ไขปัญหา

**การวินิจฉัยอย่างรวดเร็ว:**

หากคุณประสบปัญหา อธิบายปัญหาให้ Claude ทราบและ troubleshoot skill จะเปิดใช้งานอัตโนมัติเพื่อวินิจฉัยและให้การแก้ไข

**ปัญหาทั่วไป:**

- Worker ไม่เริ่มต้น → `npm run worker:restart`
- ไม่มีบริบทปรากฏ → `npm run test:context`
- ปัญหาฐานข้อมูล → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- การค้นหาไม่ทำงาน → ตรวจสอบว่ามีตาราง FTS5 อยู่

ดู [คู่มือการแก้ไขปัญหา](https://docs.claude-mem.ai/troubleshooting) สำหรับวิธีแก้ไขที่สมบูรณ์

---

## การมีส่วนร่วม

ยินดีรับการมีส่วนร่วม! กรุณา:

1. Fork repository
2. สร้าง feature branch
3. ทำการเปลี่ยนแปลงพร้อมการทดสอบ
4. อัปเดตเอกสาร
5. ส่ง Pull Request

ดู [คู่มือการพัฒนา](https://docs.claude-mem.ai/development) สำหรับขั้นตอนการมีส่วนร่วม

---

## ลิขสิทธิ์

โปรเจกต์นี้ได้รับอนุญาตภายใต้ **GNU Affero General Public License v3.0** (AGPL-3.0)

Copyright (C) 2025 Alex Newman (@thedotmack) สงวนลิขสิทธิ์ทั้งหมด

ดูไฟล์ [LICENSE](LICENSE) สำหรับรายละเอียดทั้งหมด

**สิ่งนี้หมายความว่า:**

- คุณสามารถใช้ แก้ไข และแจกจ่ายซอฟต์แวร์นี้ได้อย่างอิสระ
- หากคุณแก้ไขและปรับใช้บนเซิร์ฟเวอร์เครือข่าย คุณต้องทำให้ซอร์สโค้ดของคุณพร้อมใช้งาน
- งานที่สืบทอดจะต้องได้รับอนุญาตภายใต้ AGPL-3.0 ด้วย
- ไม่มีการรับประกันสำหรับซอฟต์แวร์นี้

---

## การสนับสนุน

- **เอกสาร**: [docs/](docs/)
- **ปัญหา**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **ผู้เขียน**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**สร้างด้วย Claude Agent SDK** | **ขับเคลื่อนโดย Claude Code** | **สร้างด้วย TypeScript**