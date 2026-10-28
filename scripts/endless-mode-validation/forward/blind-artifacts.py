"""Blind a forward run's artifacts for the judges: each configuration's turns.jsonl and snapshots are copied under a
random letter (A, B, C, ...), with the configuration name removed from every record. The key (letter ->
configuration) goes to a separate file that the judges must not see until every score is in.

Usage: python3 blind-artifacts.py <run dir> <out dir for the judges> <key file outside that dir> [<probe file>]
Also writes <out dir>/probes.tsv: the probe turns from <probe file> [probe-turns.txt; probe-turns-500.txt for a
prompts500 run], so judges score the same turns for every letter.
Configurations that run claude-mem (`off`, `timeline`, `observation`, `release`) can name it in their replies (the
release's MCP search tools and startup context are visible to the agent). Replies are never edited; the key file
lists, per letter, the turns whose reply mentions a configuration-identifying term, so whoever holds the key can
note them in the report.
"""
import json, os, random, re, secrets, shutil, sys

run_dir, out_dir, key_file = sys.argv[1:4]
probe_file = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe-turns.txt')
IDENTIFYING = re.compile(r'claude-mem|mem-search|mcp__plugin_claude|<claude-mem|endless mode|memory_search|observations? (?:from|in) (?:memory|claude)', re.I)
if os.path.abspath(key_file).startswith(os.path.abspath(out_dir) + os.sep): sys.exit('the key file must be outside the judges\' folder')
art = os.path.join(run_dir, 'artifacts')
configs = sorted(c for c in os.listdir(art) if os.path.isfile(os.path.join(art, c, 'turns.jsonl')))
letters = [chr(ord('A') + i) for i in range(len(configs))]
order = configs[:]; random.Random(secrets.randbits(64)).shuffle(order)
key = dict(zip(letters, order))
os.makedirs(out_dir, exist_ok=True)
mentions = {}
for letter, config in key.items():
    d = os.path.join(out_dir, letter); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'turns.jsonl'), 'w') as out:
        for line in open(os.path.join(art, config, 'turns.jsonl')):
            r = json.loads(line); r.pop('config', None); out.write(json.dumps(r) + '\n')
            if IDENTIFYING.search(r.get('reply') or ''): mentions.setdefault(letter, []).append(r['turn'])
    if os.path.isdir(os.path.join(art, config, 'snapshots')):
        shutil.copytree(os.path.join(art, config, 'snapshots'), os.path.join(d, 'snapshots'), dirs_exist_ok=True)
shutil.copy(probe_file, os.path.join(out_dir, 'probes.tsv'))
json.dump(dict(key=key, identifying_mentions=mentions), open(key_file, 'w'), indent=1)
print(f'{sum(map(len, mentions.values()))} replies mention claude-mem-identifying terms (turns per letter in the key file)')
print(f'{len(key)} configurations blinded as {", ".join(letters)} in {out_dir}; key in {key_file} (keep it from the judges)')
