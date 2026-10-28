"""Keep the disk small during a run: every few seconds, each tee'd request body older than 3 s is reduced to one
JSON line (what stats.py needs) in <tee dir>/extracted.jsonl and then deleted. The responses (resp.raw, which hold
the usage numbers) stay. Runs until <stop file> exists, then does a last pass over everything.

Usage: python3 extract.py <stop file> <tee dir>...
Each line: n, time, proto, conversation (Anthropic metadata.user_id / Responses prompt_cache_key), model,
tool_uses [{id, name, read_files}], messages, kind (Claude Code's summarizing request / first request continued from a
summary), timeline_blocks, timeline_chars, thinking_blocks, body_bytes.
"""
import glob, json, os, re, shlex, sys, time

FILE_CMDS = {'cat', 'head', 'tail', 'nl', 'less', 'more', 'bat'}
CONTINUED = 'This session is being continued from a previous conversation'
TIMELINE_OPEN = '<claude-mem-timeline>'
TIMELINE_CLOSE = '</claude-mem-timeline>'


def shell_reads(cmd):
    """Files a shell command prints (cat/head/tail/nl/less/more/bat, sed -n)."""
    out = []
    for part in re.split(r'&&|\|\||;|\|', cmd):
        try: toks = shlex.split(part)
        except Exception: toks = part.split()
        if not toks: continue
        if toks[0] in ('bash', 'zsh', 'sh') and '-lc' in toks: continue
        if toks[0] in FILE_CMDS or (toks[0] == 'sed' and '-n' in toks):
            out += [t for t in toks[1:] if not t.startswith('-') and re.search(r'\.\w+$', t) and not re.match(r'^\d', t)]
    return out


def timeline_of(items, content_key):
    for it in items[:20]:
        parts = it.get(content_key) if isinstance(it, dict) else None
        if not isinstance(parts, list): continue
        texts = [p.get('text', '') for p in parts if isinstance(p, dict)]
        if texts and texts[0].startswith(TIMELINE_OPEN) and TIMELINE_CLOSE in texts:
            return texts[:texts.index(TIMELINE_CLOSE)]
    return []


def extract_anthropic(b):
    msgs = b.get('messages', []); tool_uses = []; thinking = 0
    for m in msgs:
        if not isinstance(m.get('content'), list): continue
        for c in m['content']:
            t = c.get('type')
            if t in ('thinking', 'redacted_thinking'): thinking += 1
            if t == 'tool_use':
                i = c.get('input') or {}
                files = [i.get('file_path', '')] if c.get('name') == 'Read' else shell_reads(i.get('command', '')) if c.get('name') == 'Bash' else []
                tool_uses.append(dict(id=c.get('id'), name=c.get('name'), read_files=[os.path.basename(x) for x in files if x]))
    last = json.dumps(msgs[-1]).lower() if msgs else ''
    kind = 'summarizing request' if ('summary of the conversation' in last or 'summarize the conversation' in last) else \
           'continued from a summary' if msgs and CONTINUED in json.dumps(msgs[:3]) else None
    return dict(proto='anthropic', conversation=(b.get('metadata') or {}).get('user_id', ''), model=b.get('model'), tool_uses=tool_uses,
                messages=len(msgs), kind=kind, thinking_blocks=thinking, timeline=timeline_of(msgs, 'content'))


def extract_responses(b):
    items = b.get('input', []) or []; tool_uses = []
    for it in items:
        if it.get('type') not in ('function_call', 'custom_tool_call', 'local_shell_call'): continue
        args = it.get('arguments') or it.get('input') or ''; cmd = args
        try:
            a = json.loads(args); cmd = a.get('cmd') or a.get('command') or ''
            if isinstance(cmd, list): cmd = ' '.join(cmd)
        except Exception: pass
        if isinstance(cmd, str) and 'exec_command' in cmd:
            cmds = [m.group(2) for m in re.finditer(r'cmd\s*:\s*(["\'`])(.*?)(?<!\\)\1', cmd, re.S)]
            files = [x for c in cmds for x in shell_reads(c)]
        else:
            files = shell_reads(cmd) if isinstance(cmd, str) else []
        tool_uses.append(dict(id=it.get('call_id') or it.get('id'), name=it.get('name') or it.get('type'), read_files=[os.path.basename(x) for x in files if x]))
    reasoning = sum(1 for it in items if it.get('type') == 'reasoning')
    return dict(proto='responses', conversation=b.get('prompt_cache_key', ''), model=b.get('model'), tool_uses=tool_uses,
                messages=len(items), kind=None, thinking_blocks=reasoning, timeline=timeline_of(items, 'content'))


def extract(path):
    b = json.load(open(path))
    rec = extract_anthropic(b) if 'messages' in b else extract_responses(b)
    blocks = rec.pop('timeline')
    meta = json.load(open(path.replace('-req.body', '-req.json')))
    rec.update(n=os.path.basename(path)[:4], time=meta['time'], path=meta.get('path'), timeline_blocks=len(blocks),
               timeline_chars=sum(len(x) for x in blocks), body_bytes=os.path.getsize(path))
    return rec


def one_pass(tee_dirs, min_age_seconds):
    for d in tee_dirs:
        if not os.path.isdir(d): continue
        with open(os.path.join(d, 'extracted.jsonl'), 'a') as out:
            for f in sorted(glob.glob(os.path.join(d, '*-req.body'))):
                if time.time() - os.path.getmtime(f) < min_age_seconds: continue
                try: rec = extract(f)
                except Exception as e:
                    # Kept on disk and reported, never dropped: stats.py counts unextracted bodies as an error.
                    print(f'{f}: {e}', file=sys.stderr); continue
                out.write(json.dumps(rec) + '\n'); out.flush(); os.remove(f)


if __name__ == '__main__':
    stop_file, tee_dirs = sys.argv[1], sys.argv[2:]
    # 3 s: a body is written in one call before its request goes upstream; 3 s is well past that write.
    while not os.path.exists(stop_file):
        one_pass(tee_dirs, 3); time.sleep(5)
    one_pass(tee_dirs, 0)
