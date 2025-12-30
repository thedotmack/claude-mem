# Claude-Mem Documentation

This directory contains technical documentation for the claude-mem project.

## 📋 Current Documentation

### Implementation & Status

- **[PR #464 Implementation Summary](./pr-464-implementation-summary.md)** - Comprehensive overview of Sleep Agent Pipeline implementation
- **[Titans Integration Status](./titans-integration-status.md)** - Status of Titans concepts integration (Phases 1-3 complete)
- **[Diffray-bot Fixes](./diffray-low-priority-fixes.md)** - Complete resolution of code quality issues

### Architecture & Design

- **[Pipeline Architecture Analysis](./pipeline-architecture-analysis.md)** - Five-stage LLM processing pipeline design
- **[Nested Learning Analysis](./nested-learning-analysis.md)** - Research correlation (中文)
- **[Nested Learning Analysis (EN)](./nested-learning-analysis.en.md)** - English translation
- **[Sleep Agent Optimization](./sleep-agent-optimization.md)** - Performance analysis (中文)

### Public Documentation

- **[Public Docs](./public/)** - User-facing documentation (Mintlify)
  - Auto-deploys from GitHub to https://docs.claude-mem.ai
  - Edit navigation in `docs.json`

### Reference Materials

- **[Context/](./context/)** - Agent SDK v2 preview, Cursor hooks reference
- **[Analysis/](./analysis/)** - Continuous Claude v2 comparison
- **[i18n/](./i18n/)** - Internationalized README files

### Archive

- **[Archive/](./archive/)** - Historical planning documents
  - `titans-integration-plan.md` - Original planning (superseded by titans-integration-status.md)

## 🎯 Quick Navigation

### For Contributors

Start with:
1. [PR #464 Implementation Summary](./pr-464-implementation-summary.md) - What's been built
2. [Titans Integration Status](./titans-integration-status.md) - Current implementation status
3. [Pipeline Architecture Analysis](./pipeline-architecture-analysis.md) - How pipeline works

### For Maintainers

Review:
1. [Diffray-bot Fixes](./diffray-low-priority-fixes.md) - All code quality issues resolved
2. [PR #464 Implementation Summary](./pr-464-implementation-summary.md) - Full feature list
3. Architecture documents for design decisions

### For Users

Visit:
- **https://docs.claude-mem.ai** - User-facing documentation
- `/docs/public/` - Documentation source files

## 📊 Documentation by Topic

### Sleep Agent & Memory Management

- [PR #464 Implementation Summary](./pr-464-implementation-summary.md) - Full implementation
- [Titans Integration Status](./titans-integration-status.md) - Titans concepts
- [Nested Learning Analysis](./nested-learning-analysis.md) - Research correlation
- [Sleep Agent Optimization](./sleep-agent-optimization.md) - Performance details

### Pipeline & Processing

- [Pipeline Architecture Analysis](./pipeline-architecture-analysis.md) - Five-stage design
- [PR #464 Implementation Summary](./pr-464-implementation-summary.md) - Implementation details

### Code Quality

- [Diffray-bot Fixes](./diffray-low-priority-fixes.md) - All resolved issues
- [PR #464 Implementation Summary](./pr-464-implementation-summary.md) - Quality metrics

## 🔄 Documentation Updates

**Last Major Update**: 2025-12-30

**Recent Changes:**
- ✅ Added PR #464 implementation summary
- ✅ Created Titans integration status document
- ✅ Added diffray-bot fixes documentation
- ✅ Archived outdated planning documents
- ✅ Created this README for navigation

## 📝 Writing Documentation

### File Naming

- Use kebab-case: `feature-name-description.md`
- Include language suffix for translations: `file-name.en.md`, `file-name.zh.md`
- Use descriptive names that indicate content and purpose

### Document Structure

Include at the top:
- Status indicator (✅ Complete, ⏳ In Progress, ⏸️ Deferred)
- Last updated date
- Related PR or commit references

### Chinese/English

- Implementation docs: Prefer English for international collaboration
- Analysis docs: Either language acceptable, provide translation if possible
- User docs: English primary, i18n translations in `i18n/` folder

## 🗂️ Directory Structure

```
docs/
├── README.md                              # This file
├── pr-464-implementation-summary.md       # Current: Implementation overview
├── titans-integration-status.md           # Current: Titans status
├── diffray-low-priority-fixes.md          # Current: Code quality fixes
├── pipeline-architecture-analysis.md      # Current: Pipeline design
├── nested-learning-analysis.md            # Current: Research (中文)
├── nested-learning-analysis.en.md         # Current: Research (EN)
├── sleep-agent-optimization.md            # Current: Performance (中文)
├── public/                                # User-facing docs (Mintlify)
│   ├── CLAUDE.md
│   └── ...
├── context/                               # Reference materials
│   ├── agent-sdk-v2-preview.md
│   └── cursor-hooks-reference.md
├── analysis/                              # Analysis documents
│   └── continuous-claude-v2-comparison.md
├── i18n/                                  # Translations
│   ├── README.zh.md
│   ├── README.es.md
│   └── ...
└── archive/                               # Historical documents
    └── titans-integration-plan.md
```

## 🔗 External Links

- **Project Repository**: https://github.com/thedotmack/claude-mem
- **Public Documentation**: https://docs.claude-mem.ai
- **PR #464**: https://github.com/thedotmack/claude-mem/pull/464
- **Titans Research**: https://research.google/blog/titans-miras-helping-ai-have-long-term-memory/

## 💡 Tips

- Always check the last updated date on documents
- Archived documents are for historical reference only
- For current status, see implementation summary and status documents
- For design rationale, see architecture analysis documents
- For user guidance, visit public documentation site

---

**Maintained by**: claude-mem contributors
**Last Updated**: 2025-12-30
