🌐 यह एक स्वचालित अनुवाद है। समुदाय से सुधार का स्वागत है!

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

<h4 align="center"><a href="https://claude.com/claude-code" target="_blank">Claude Code</a> के लिए बनाई गई स्थायी मेमोरी संपीड़न प्रणाली।</h4>

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
  <a href="#quick-start">त्वरित शुरुआत</a> •
  <a href="#how-it-works">यह कैसे काम करता है</a> •
  <a href="#mcp-search-tools">खोज उपकरण</a> •
  <a href="#documentation">दस्तावेज़ीकरण</a> •
  <a href="#configuration">कॉन्फ़िगरेशन</a> •
  <a href="#troubleshooting">समस्या निवारण</a> •
  <a href="#license">लाइसेंस</a>
</p>

<p align="center">
  Claude-Mem स्वचालित रूप से टूल उपयोग अवलोकनों को कैप्चर करके, सिमेंटिक सारांश उत्पन्न करके, और उन्हें भविष्य के सत्रों के लिए उपलब्ध कराकर सत्रों में संदर्भ को निर्बाध रूप से संरक्षित करता है। यह Claude को परियोजनाओं के बारे में ज्ञान की निरंतरता बनाए रखने में सक्षम बनाता है, भले ही सत्र समाप्त हो जाएं या पुनः कनेक्ट हो जाएं।
</p>

---

## त्वरित शुरुआत

टर्मिनल में एक नया Claude Code सत्र शुरू करें और निम्नलिखित कमांड दर्ज करें:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Claude Code को पुनः आरंभ करें। पिछले सत्रों का संदर्भ स्वचालित रूप से नए सत्रों में दिखाई देगा।

**मुख्य विशेषताएं:**

- 🧠 **स्थायी मेमोरी** - संदर्भ सत्रों में बना रहता है
- 📊 **प्रगतिशील प्रकटीकरण** - टोकन लागत दृश्यता के साथ स्तरित मेमोरी पुनर्प्राप्ति
- 🔍 **स्किल-आधारित खोज** - mem-search स्किल के साथ अपने प्रोजेक्ट इतिहास को क्वेरी करें
- 🖥️ **वेब व्यूअर UI** - http://localhost:37777 पर रीयल-टाइम मेमोरी स्ट्रीम
- 💻 **Claude Desktop स्किल** - Claude Desktop वार्तालापों से मेमोरी खोजें
- 🔒 **गोपनीयता नियंत्रण** - संवेदनशील सामग्री को स्टोरेज से बाहर रखने के लिए `<private>` टैग का उपयोग करें
- ⚙️ **संदर्भ कॉन्फ़िगरेशन** - किस संदर्भ को इंजेक्ट किया जाता है, इस पर सूक्ष्म नियंत्रण
- 🤖 **स्वचालित संचालन** - मैन्युअल हस्तक्षेप की आवश्यकता नहीं
- 🔗 **उद्धरण** - IDs के साथ पिछले अवलोकनों का संदर्भ दें (http://localhost:37777/api/observation/{id} के माध्यम से एक्सेस करें या http://localhost:37777 पर वेब व्यूअर में सभी देखें)
- 🧪 **बीटा चैनल** - संस्करण स्विचिंग के माध्यम से Endless Mode जैसी प्रायोगिक सुविधाओं को आज़माएं

---

## दस्तावेज़ीकरण

📚 **[पूर्ण दस्तावेज़ीकरण देखें](https://docs.claude-mem.ai/)** - आधिकारिक वेबसाइट पर ब्राउज़ करें

### शुरुआत करना

- **[इंस्टॉलेशन गाइड](https://docs.claude-mem.ai/installation)** - त्वरित शुरुआत और उन्नत इंस्टॉलेशन
- **[उपयोग गाइड](https://docs.claude-mem.ai/usage/getting-started)** - Claude-Mem स्वचालित रूप से कैसे काम करता है
- **[खोज उपकरण](https://docs.claude-mem.ai/usage/search-tools)** - प्राकृतिक भाषा के साथ अपने प्रोजेक्ट इतिहास को क्वेरी करें
- **[बीटा सुविधाएं](https://docs.claude-mem.ai/beta-features)** - Endless Mode जैसी प्रायोगिक सुविधाओं को आज़माएं

### सर्वोत्तम अभ्यास

- **[संदर्भ इंजीनियरिंग](https://docs.claude-mem.ai/context-engineering)** - AI एजेंट संदर्भ अनुकूलन सिद्धांत
- **[प्रगतिशील प्रकटीकरण](https://docs.claude-mem.ai/progressive-disclosure)** - Claude-Mem की संदर्भ प्राइमिंग रणनीति के पीछे का दर्शन

### आर्किटेक्चर

- **[अवलोकन](https://docs.claude-mem.ai/architecture/overview)** - सिस्टम घटक और डेटा प्रवाह
- **[आर्किटेक्चर विकास](https://docs.claude-mem.ai/architecture-evolution)** - v3 से v5 तक की यात्रा
- **[Hooks आर्किटेक्चर](https://docs.claude-mem.ai/hooks-architecture)** - Claude-Mem जीवनचक्र hooks का उपयोग कैसे करता है
- **[Hooks संदर्भ](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook स्क्रिप्ट समझाई गई
- **[Worker सेवा](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API और Bun प्रबंधन
- **[डेटाबेस](https://docs.claude-mem.ai/architecture/database)** - SQLite स्कीमा और FTS5 खोज
- **[खोज आर्किटेक्चर](https://docs.claude-mem.ai/architecture/search-architecture)** - Chroma वेक्टर डेटाबेस के साथ हाइब्रिड खोज

### कॉन्फ़िगरेशन और विकास

- **[कॉन्फ़िगरेशन](https://docs.claude-mem.ai/configuration)** - पर्यावरण चर और सेटिंग्स
- **[विकास](https://docs.claude-mem.ai/development)** - बिल्डिंग, परीक्षण, योगदान
- **[समस्या निवारण](https://docs.claude-mem.ai/troubleshooting)** - सामान्य समस्याएं और समाधान

---

## यह कैसे काम करता है

**मुख्य घटक:**

1. **5 जीवनचक्र Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 hook स्क्रिप्ट)
2. **स्मार्ट इंस्टॉल** - कैश्ड डिपेंडेंसी चेकर (pre-hook स्क्रिप्ट, जीवनचक्र hook नहीं)
3. **Worker सेवा** - वेब व्यूअर UI और 10 खोज endpoints के साथ पोर्ट 37777 पर HTTP API, Bun द्वारा प्रबंधित
4. **SQLite डेटाबेस** - सत्र, अवलोकन, सारांश संग्रहीत करता है
5. **mem-search स्किल** - प्रगतिशील प्रकटीकरण के साथ प्राकृतिक भाषा क्वेरी
6. **Chroma वेक्टर डेटाबेस** - बुद्धिमान संदर्भ पुनर्प्राप्ति के लिए हाइब्रिड सिमेंटिक + कीवर्ड खोज

विवरण के लिए [आर्किटेक्चर अवलोकन](https://docs.claude-mem.ai/architecture/overview) देखें।

---

## mem-search स्किल

Claude-Mem mem-search स्किल के माध्यम से बुद्धिमान खोज प्रदान करता है जो स्वचालित रूप से सक्रिय हो जाती है जब आप पिछले काम के बारे में पूछते हैं:

**यह कैसे काम करता है:**
- बस स्वाभाविक रूप से पूछें: *"हमने पिछले सत्र में क्या किया?"* या *"क्या हमने पहले इस बग को ठीक किया था?"*
- Claude स्वचालित रूप से प्रासंगिक संदर्भ खोजने के लिए mem-search स्किल को सक्रिय करता है

**उपलब्ध खोज संचालन:**

1. **अवलोकन खोजें** - अवलोकनों में पूर्ण-पाठ खोज
2. **सत्र खोजें** - सत्र सारांशों में पूर्ण-पाठ खोज
3. **प्रॉम्प्ट खोजें** - कच्चे उपयोगकर्ता अनुरोध खोजें
4. **अवधारणा द्वारा** - अवधारणा टैग द्वारा खोजें (discovery, problem-solution, pattern, आदि)
5. **फ़ाइल द्वारा** - विशिष्ट फ़ाइलों का संदर्भ देने वाले अवलोकन खोजें
6. **प्रकार द्वारा** - प्रकार द्वारा खोजें (decision, bugfix, feature, refactor, discovery, change)
7. **हालिया संदर्भ** - एक प्रोजेक्ट के लिए हालिया सत्र संदर्भ प्राप्त करें
8. **टाइमलाइन** - समय में एक विशिष्ट बिंदु के आसपास संदर्भ की एकीकृत टाइमलाइन प्राप्त करें
9. **क्वेरी द्वारा टाइमलाइन** - अवलोकनों को खोजें और सर्वश्रेष्ठ मिलान के आसपास टाइमलाइन संदर्भ प्राप्त करें
10. **API सहायता** - खोज API दस्तावेज़ीकरण प्राप्त करें

**प्राकृतिक भाषा क्वेरी के उदाहरण:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

विस्तृत उदाहरणों के लिए [खोज उपकरण गाइड](https://docs.claude-mem.ai/usage/search-tools) देखें।

---

## बीटा सुविधाएं

Claude-Mem **बीटा चैनल** के साथ **Endless Mode** (विस्तारित सत्रों के लिए बायोमिमेटिक मेमोरी आर्किटेक्चर) जैसी प्रायोगिक सुविधाएं प्रदान करता है। http://localhost:37777 → Settings पर वेब व्यूअर UI से स्थिर और बीटा संस्करणों के बीच स्विच करें।

Endless Mode के विवरण और इसे आज़माने के तरीके के लिए **[बीटा सुविधाएं दस्तावेज़ीकरण](https://docs.claude-mem.ai/beta-features)** देखें।

---

## सिस्टम आवश्यकताएं

- **Node.js**: 18.0.0 या उच्चतर
- **Claude Code**: प्लगइन समर्थन के साथ नवीनतम संस्करण
- **Bun**: JavaScript रनटाइम और प्रोसेस मैनेजर (यदि गायब हो तो ऑटो-इंस्टॉल)
- **uv**: वेक्टर खोज के लिए Python पैकेज मैनेजर (यदि गायब हो तो ऑटो-इंस्टॉल)
- **SQLite 3**: स्थायी स्टोरेज के लिए (बंडल किया गया)

---

## कॉन्फ़िगरेशन

सेटिंग्स `~/.claude-mem/settings.json` में प्रबंधित की जाती हैं (पहली बार चलने पर डिफ़ॉल्ट के साथ ऑटो-निर्मित)। AI मॉडल, worker पोर्ट, डेटा डायरेक्टरी, लॉग स्तर, और संदर्भ इंजेक्शन सेटिंग्स कॉन्फ़िगर करें।

सभी उपलब्ध सेटिंग्स और उदाहरणों के लिए **[कॉन्फ़िगरेशन गाइड](https://docs.claude-mem.ai/configuration)** देखें।

---

## विकास

बिल्ड निर्देश, परीक्षण, और योगदान वर्कफ़्लो के लिए **[विकास गाइड](https://docs.claude-mem.ai/development)** देखें।

---

## समस्या निवारण

यदि समस्याओं का सामना कर रहे हैं, तो Claude को समस्या का वर्णन करें और troubleshoot स्किल स्वचालित रूप से निदान करेगी और सुधार प्रदान करेगी।

सामान्य समस्याओं और समाधानों के लिए **[समस्या निवारण गाइड](https://docs.claude-mem.ai/troubleshooting)** देखें।

---

## बग रिपोर्ट

स्वचालित जेनरेटर के साथ व्यापक बग रिपोर्ट बनाएं:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## योगदान

योगदान का स्वागत है! कृपया:

1. रिपॉजिटरी को Fork करें
2. एक feature ब्रांच बनाएं
3. परीक्षणों के साथ अपने परिवर्तन करें
4. दस्तावेज़ीकरण अपडेट करें
5. एक Pull Request सबमिट करें

योगदान वर्कफ़्लो के लिए [विकास गाइड](https://docs.claude-mem.ai/development) देखें।

---

## License

This project is licensed under the **Apache License 2.0** (Apache-2.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

Apache-2.0 allows broad use, modification, distribution, and commercial use, subject to its terms.

**Ragtime note**: The ragtime/ directory is licensed under the **Apache License 2.0**. See [ragtime/LICENSE](ragtime/LICENSE) for details.

---


## समर्थन

- **दस्तावेज़ीकरण**: [docs/](docs/)
- **समस्याएं**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **रिपॉजिटरी**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **लेखक**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Claude Agent SDK के साथ निर्मित** | **Claude Code द्वारा संचालित** | **TypeScript के साथ बनाया गया**

---