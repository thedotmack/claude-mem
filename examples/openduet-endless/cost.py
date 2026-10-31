"""What OpenDuet's model calls through the gateway cost, from the gateway's own token counts and OpenRouter's live prices.
Usage: python3 cost.py [days]   (default: everything the gateway still keeps, 7 days)

Counts only the calls that went through the gateway (OpenDuet's chat, its router and titles). claude-mem's own
observer calls go straight to OpenRouter and are not in here; OpenRouter's Activity page shows the whole bill.
"""
import datetime, glob, json, os, sys, urllib.request
from collections import defaultdict

home = os.environ.get('OPENDUET_ENDLESS_HOME', os.path.expanduser('~/openduet-endless'))
days = int(sys.argv[1]) if len(sys.argv) > 1 else None
since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).isoformat() if days else ''

rows = []
for path in sorted(glob.glob(os.path.join(home, 'claude-mem-data', 'wire-gateway', 'usage', '*.jsonl'))):
    for line in open(path):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('routeId') == 'openduet' and r.get('t', '') >= since and r.get('status') == 200:
            rows.append(r)
if not rows:
    sys.exit('No OpenDuet calls recorded yet.')

models_url = os.environ.get('OPENROUTER_MODELS_URL', 'https://openrouter.ai/api/v1/models')
with urllib.request.urlopen(models_url, timeout=30) as response:
    catalog = {m['id']: m['pricing'] for m in json.load(response)['data']}

def per_token(pricing, key, fallback=None):
    value = pricing.get(key)
    return float(value) if value not in (None, '') else (float(pricing[fallback]) if fallback else 0.0)

def cost(r):
    p = catalog.get(r['model'])
    if p is None:
        return None
    return (r['in'] * per_token(p, 'prompt')
            + r['cacheRead'] * per_token(p, 'input_cache_read', 'prompt')
            + (r['cacheWrite'] + r.get('cacheWrite1h', 0)) * per_token(p, 'input_cache_write', 'prompt')
            + r['out'] * per_token(p, 'completion'))

total, unpriced = 0.0, set()
by_conversation = defaultdict(lambda: [0, 0.0])
tokens = defaultdict(int)
for r in rows:
    c = cost(r)
    if c is None:
        unpriced.add(r['model'])
        continue
    total += c
    by_conversation[r['session']][0] += 1
    by_conversation[r['session']][1] += c
    for k in ('in', 'cacheRead', 'out'):
        tokens[k] += r[k]

models = sorted({r['model'] for r in rows})
print(f"Model calls: {len(rows)} ({', '.join(models)})")
print(f"Tokens: {tokens['in']:,} new input, {tokens['cacheRead']:,} cached input, {tokens['out']:,} output")
print(f"Total: ${total:.4f}")
print(f"Per model call: ${total / max(len(rows), 1):.5f}")
print(f"Conversations: {len(by_conversation)}, ${total / max(len(by_conversation), 1):.4f} each on average")
if unpriced:
    print(f"Not priced (not in OpenRouter's list now): {', '.join(sorted(unpriced))}")
print("Prices: https://openrouter.ai/api/v1/models, read just now. Endless Mode savings: status.sh")
