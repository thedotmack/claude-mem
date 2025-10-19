# XML Extraction Scripts

Scripts to extract XML observations and summaries from Claude Code transcript files.

## Scripts

### `filter-actual-xml.py`
**Recommended for import**

Extracts only actual XML from assistant responses, filtering out:
- Template/example XML (with placeholders like `[...]` or `**field**:`)
- XML from tool_use blocks
- XML from user messages

**Output:** `~/Scripts/claude-mem/actual_xml_only_with_timestamps.xml`

**Usage:**
```bash
python3 scripts/extraction/filter-actual-xml.py
```

### `extract-all-xml.py`
**For debugging/analysis**

Extracts ALL XML blocks from transcripts without filtering.

**Output:** `~/Scripts/claude-mem/all_xml_fragments_with_timestamps.xml`

**Usage:**
```bash
python3 scripts/extraction/extract-all-xml.py
```

## Workflow

1. **Extract XML from transcripts:**
   ```bash
   cd ~/Scripts/claude-mem
   python3 scripts/extraction/filter-actual-xml.py
   ```

2. **Import to database:**
   ```bash
   npm run import:xml
   ```

3. **Clean up duplicates (if needed):**
   ```bash
   npm run cleanup:duplicates
   ```

## Source Data

Scripts read from: `~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/*.jsonl`

These are Claude Code session transcripts stored in JSONL (JSON Lines) format.

## Output Format

```xml
<?xml version="1.0" encoding="UTF-8"?>
<transcript_extracts>

<!-- Block 1 | 2025-10-19 03:03:23 UTC -->
<observation>
  <type>discovery</type>
  <title>Example observation</title>
  ...
</observation>

<!-- Block 2 | 2025-10-19 03:03:45 UTC -->
<summary>
  <request>What was accomplished</request>
  ...
</summary>

</transcript_extracts>
```

Each XML block includes a comment with:
- Block number
- Original timestamp from transcript
