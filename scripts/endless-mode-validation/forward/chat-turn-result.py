"""Reads one Hermes or OpenClaw turn's raw output, writes {result, session_id} and prints agent-turn.sh's status line.
A turn with no reply text is an error: it is reported, never counted as a good turn.

Usage: python3 chat-turn-result.py <hermes|openclaw> <raw output> <stderr file> <out json> <exit code> <seconds> <sid file>
"""
import json, re, sys

agent, raw_path, err_path, out_path, rc, secs, sid_file = sys.argv[1:8]
raw = open(raw_path, errors='replace').read()
reply, sid = None, None
if agent == 'hermes':
    # Quiet mode prints the reply on stdout and a line `session_id: <id>` on stderr.
    m = re.search(r'^session_id:\s*(\S+)\s*$', open(err_path, errors='replace').read(), re.M)
    sid = m.group(1) if m else None
    reply = raw.strip()
else:
    start = raw.find('{')
    try:
        d = json.loads(raw[start:]) if start >= 0 else {}
        body = d.get('result') if isinstance(d.get('result'), dict) else d
        reply = '\n'.join(p.get('text') or '' for p in body.get('payloads') or []).strip()
        sid = open(sid_file).read().strip()
        if body.get('meta', {}).get('error') or body.get('meta', {}).get('aborted'):
            rc = rc if rc != '0' else 'agent-error'
    except ValueError:
        pass
if sid: open(sid_file, 'w').write(sid)
json.dump(dict(result=reply, session_id=sid), open(out_path, 'w'))
print('rc=%s secs=%s error=%s sid=%s' % (rc, secs, rc != '0' or not reply, sid))
print((reply or '').replace('\n', ' ')[:300])
