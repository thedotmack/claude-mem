"""Write a prices file for one OpenRouter model from OpenRouter's public model list, with the fetch time.
Usage: python3 fetch-openrouter-prices.py <model id> <out file>
OpenRouter lists per-token prices (prompt, completion, input_cache_read, input_cache_write); this converts them to
USD per million tokens. A cache write with no listed price is priced as input (prompt), and the file says so.
"""
import datetime, json, sys, urllib.request

model_id, out = sys.argv[1], sys.argv[2]
with urllib.request.urlopen('https://openrouter.ai/api/v1/models', timeout=30) as r:
    models = json.load(r)['data']
m = next((x for x in models if x['id'] == model_id), None)
if m is None: sys.exit(f'{model_id} is not in https://openrouter.ai/api/v1/models')
p = m['pricing']
per_m = lambda k: round(float(p[k]) * 1e6, 9) if p.get(k) not in (None, '') else None
write = per_m('input_cache_write')
doc = dict(model=model_id, unit='USD per million tokens', input=per_m('prompt'), cache_read=per_m('input_cache_read'),
           cache_write_5m=write if write is not None else per_m('prompt'), cache_write_1h=write if write is not None else per_m('prompt'),
           output=per_m('completion'), context_length=m.get('context_length'), raw_pricing=p,
           source=f'https://openrouter.ai/api/v1/models, fetched {datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}'
                  + ('' if write is not None else '; no cache-write price listed, priced as input'))
json.dump(doc, open(out, 'w'), indent=1)
print(f"{model_id}: input ${doc['input']}/MTok, cache read ${doc['cache_read']}/MTok, output ${doc['output']}/MTok ({doc['source']})")
