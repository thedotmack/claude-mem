"""Case (o): each recorded request with everything claude-mem added taken out.

What counts as claude-mem's (matched against the plugin's code in the worktree):
- Hook output the model sees, from the claude-mem hooks in plugin/hooks/hooks.json (`claude-mem hook claude-code
  context|session-init|file-context|...`) and the CMEM Pro plugin's `cmem-hook.mjs`: SessionStart additional
  context (src/cli/handlers/context.ts: the `<claude-mem-context` timeline, the `# [<project>] recent context`
  header, `# Work state:` (WorkStateRenderer), MEMORY_PLUGIN_INSTRUCTIONS `# claude-mem memory use`, and a
  `<persisted-output>` stand-in for one of those when it was too large), PreToolUse:Read file context
  (src/cli/handlers/file-context.ts: `This file has prior observations`), and any non-empty `hook success`
  output of a claude-mem command. Found per session from the transcript's attachment entries, then removed
  as exact substrings from the request's text blocks.
- claude-mem MCP tools: definitions in the tool list (names `mcp__plugin_claude-mem*__*`, the hosted
  connector `mcp__claude_ai_Claude-Mem__*`), their tool_addition blocks, their names in deferred-tool
  listings, their MCP server instructions (`## plugin:claude-mem...` / `## claude.ai Claude-Mem` sections),
  and claude-mem skills in the skill listing (`- claude-mem:` / `- claude-mem-cowork:` lines).
- claude-mem tool calls (tool_use with those names) and their tool_result blocks.
Not removed: your own CLAUDE.md text (including any `# claude-mem memory use` section and an @-included
MY-RULES.md, which you placed there; no claude-mem code writes CLAUDE.md).
Token accounting: a removed block loses its attributed tokens; an edited text block keeps
tokens * (characters left / characters before); removed head tools lose their head share.
Usage: python3 claude_mem_off.py <session dir>  (writes o.json)
"""
import json, os, re, sys, hashlib, collections
sys.path.insert(0, os.path.dirname(__file__))
from build_sessions import weight_chars, images_in

CM_TOOL = re.compile(r'(mcp__plugin_claude-mem[\w-]*__[\w-]+|mcp__claude_ai_Claude-Mem__[\w-]+)')
CM_SKILL_LINE = re.compile(r'^- claude-mem(-cowork)?:[^\n]*\n?', re.M)
CM_TOOL_LINE = re.compile(r'^[ \t-]*(mcp__plugin_claude-mem[\w-]*__[\w-]+|mcp__claude_ai_Claude-Mem__[\w-]+)[^\n]*\n?', re.M)
CM_MCP_SECTION = re.compile(r'## (plugin:claude-mem[^\n]*|claude\.ai Claude-Mem[^\n]*)\n.*?(?=\n## |\n</system-reminder>|\Z)', re.S)
CM_HOOK_CMD = re.compile(r'claude-mem|cmem-hook')
CM_CONTEXT_START = ('<claude-mem-context', '# Work state:', '# claude-mem memory use', 'Current: ')
CM_RECENT = re.compile(r'^# \[[^\]]+\] recent context')

def is_cm_context_element(text, hook):
    t = text.lstrip()
    if t.startswith(('<claude-mem-context', '# Work state:', '# claude-mem memory use')): return True
    if CM_RECENT.match(t): return True
    if 'This file has prior observations' in t[:400]: return True
    if t.startswith('<persisted-output>') and (hook or '').startswith('SessionStart') and ('recent context' in t or 'claude-mem' in t or 'Work state' in t): return True
    return False

def claude_mem_strings(path):
    """The exact strings claude-mem's hooks put in front of the model in this session."""
    found = collections.OrderedDict()
    for line in open(path, errors='replace'):
        if '"attachment"' not in line: continue
        try: d = json.loads(line)
        except Exception: continue
        if d.get('isSidechain') or d.get('type') != 'attachment': continue
        a = d['attachment']; t = a.get('type')
        if t == 'hook_additional_context':
            for c in a.get('content') or []:
                if isinstance(c, str) and c.strip() and is_cm_context_element(c, a.get('hookName') or a.get('hookEvent')): found[c] = a.get('hookName') or a.get('hookEvent')
        elif t == 'hook_success' and CM_HOOK_CMD.search(a.get('command') or '') and (a.get('content') or '').strip():
            found[a['content']] = a.get('hookName')
    return found

def claude_mem_tool_schema_chars(path):
    """Characters of each claude-mem tool's definition, from the transcript's deferred-tool records."""
    out = {}
    for line in open(path, errors='replace'):
        if 'claude-mem' not in line and 'Claude-Mem' not in line: continue
        if '"api-request-shape"' not in line and '"deferred_tools_record"' not in line: continue
        try: d = json.loads(line)
        except Exception: continue
        tools = (d.get('shape') or {}).get('tools') or (d.get('attachment') or {}).get('entries') or []
        for t in tools:
            n = t.get('name') or ''
            if CM_TOOL.fullmatch(n): out[n] = max(out.get(n, 0), len(json.dumps(t, ensure_ascii=False)))
    return out

SCHEMA_CHARS_PER_TOKEN = 2.9  # recorded heads (tool JSON + system text) measure 2.9-3.2 characters per token

def strip_text(text, cm_strings):
    out = text
    for s in cm_strings:
        if s in out: out = out.replace(s, '')
    out = CM_MCP_SECTION.sub('', out)
    out = CM_SKILL_LINE.sub('', out)
    out = CM_TOOL_LINE.sub('', out)
    return out

EMPTY_HOOK_WRAPPER = re.compile(r'^(<system-reminder>\s*)?(\w[\w:]*) hook (additional context|success):\s*(</system-reminder>)?\s*$', re.S)

def transform(sess_dir):
    sess = json.load(open(os.path.join(sess_dir, 'session.json')))
    blocks = sess['blocks']
    cm = claude_mem_strings(sess['meta']['path'])
    cm_list = sorted(cm, key=len, reverse=True)
    schema_chars = claude_mem_tool_schema_chars(sess['meta']['path'])
    new_blocks = {}; memo = {}
    removed = collections.Counter()  # category -> tokens removed (summed over unique blocks, first request each appears)
    def edit_block(i, cm_call_ids):
        """New id (or None to drop) for block i, and the category of what changed."""
        key = (i, frozenset())
        b = json.loads(blocks[i]['raw']); kind = b.get('type')
        if kind == 'tool_use' and CM_TOOL.fullmatch(b.get('name') or ''): return None, 'claude-mem tool calls and results'
        if kind == 'tool_result' and b.get('tool_use_id') in cm_call_ids: return None, 'claude-mem tool calls and results'
        if kind == 'tool_result' and isinstance(b.get('content'), list) and any(x.get('type') == 'tool_reference' and CM_TOOL.fullmatch(x.get('tool_name') or '') for x in b['content']):
            # ToolSearch loading claude-mem tools: the reference expands to the tool's schema in the prompt
            if i in memo: return memo[i]
            gone = [x for x in b['content'] if x.get('type') == 'tool_reference' and CM_TOOL.fullmatch(x.get('tool_name') or '')]
            nb = dict(b); nb['content'] = [x for x in b['content'] if x not in gone]
            raw = json.dumps(nb, separators=(',', ':'), ensure_ascii=False)
            nid = 'o:' + hashlib.sha256(raw.encode()).hexdigest()[:24]
            cut = sum(schema_chars.get(x.get('tool_name'), 0) for x in gone) / SCHEMA_CHARS_PER_TOKEN
            new_blocks[nid] = {'raw': raw, 'tokens': max(0.0, blocks[i]['tokens'] - cut), 'kind': 'tool_result', 'how': 'o-edit'}
            memo[i] = (nid, 'claude-mem MCP tool definitions'); return memo[i]
        if kind == 'tool_addition':
            name = (((b.get('tool') or {}).get('definition') or {}).get('name')) or ''
            if CM_TOOL.fullmatch(name): return None, 'claude-mem MCP tool definitions'
            return i, None
        if kind == 'text':
            if i in memo: return memo[i]
            t = b.get('text', ''); nt = strip_text(t, cm_list)
            if nt == t: memo[i] = (i, None); return memo[i]
            cat = 'hook context' if any(s in t for s in cm_list) else 'claude-mem MCP tool definitions'
            if EMPTY_HOOK_WRAPPER.match(nt) or nt.strip() == '':
                memo[i] = (None, cat); return memo[i]
            nb = dict(b); nb['text'] = nt
            raw = json.dumps(nb, separators=(',', ':'), ensure_ascii=False)
            nid = 'o:' + hashlib.sha256(raw.encode()).hexdigest()[:24]
            old_w = weight_chars(b) or 1
            new_blocks[nid] = {'raw': raw, 'tokens': blocks[i]['tokens'] * (weight_chars(nb) or 0) / old_w, 'kind': 'text', 'how': 'o-edit'}
            memo[i] = (nid, cat); return memo[i]
        return i, None
    out = []
    seen_removed = set()
    for r in sess['requests']:
        cm_call_ids = set()
        for _, ids in r['msgs_real']:
            for i in ids:
                if blocks[i]['kind'] == 'tool_use':
                    b = json.loads(blocks[i]['raw'])
                    if CM_TOOL.fullmatch(b.get('name') or ''): cm_call_ids.add(b.get('id'))
        msgs = []
        for role, ids in r['msgs_real']:
            nids = []
            for i in ids:
                nid, cat = edit_block(i, cm_call_ids)
                if cat and (i not in seen_removed):
                    seen_removed.add(i)
                    after = 0.0 if nid is None else (new_blocks[nid]['tokens'] if nid in new_blocks else blocks[nid]['tokens'])
                    removed[cat] += blocks[i]['tokens'] - after
                if nid is not None: nids.append(nid)
            if nids: msgs.append([role, nids])
        tools = []
        for i in r['tools']:
            b = json.loads(blocks[i]['raw'])
            if CM_TOOL.fullmatch(b.get('name') or ''):
                if ('head', i) not in seen_removed: seen_removed.add(('head', i)); removed['claude-mem MCP tool definitions (tool list)'] += blocks[i]['tokens']
                continue
            tools.append(i)
        sys_ids = []
        for i in r['sys']:
            nid, cat = edit_block(i, set())
            if cat and i not in seen_removed:
                seen_removed.add(i); after = 0.0 if nid is None else (new_blocks[nid]['tokens'] if nid in new_blocks else blocks[nid]['tokens'])
                removed[cat] += blocks[i]['tokens'] - after
            if nid is not None: sys_ids.append(nid)
        # merge messages of one role left next to each other by a removal (Anthropic merges them anyway)
        # messages left next to one of the same role are not merged (Anthropic merges them server-side); merging
        # here would change an earlier message when a later one arrives and fake a prefix change
        merged = msgs
        out.append(dict(i=r['i'], tools=tools, sys=sys_ids, msgs=merged))
    json.dump(dict(requests=out, new_blocks=new_blocks, removed_tokens=dict(removed), claude_mem_strings=len(cm),
                   claude_mem_string_hooks=collections.Counter(cm.values())), open(os.path.join(sess_dir, 'o.json'), 'w'), ensure_ascii=False)
    return removed, cm

if __name__ == '__main__':
    for d in sys.argv[1:]:
        removed, cm = transform(d)
        print(os.path.basename(d), {k: round(v) for k, v in removed.items()}, 'claude-mem strings', len(cm))
