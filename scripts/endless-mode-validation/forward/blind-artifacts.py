"""Blind a forward run's artifacts for the judges: each configuration's turns.jsonl and snapshots are copied under a
random letter (A, B, C, ...), with the configuration name removed from every record. The key (letter ->
configuration) goes to a separate file that the judges must not see until every score is in.

Usage: python3 blind-artifacts.py <run dir> <out dir for the judges> <key file outside that dir>
Also writes <out dir>/probes.tsv: the probe turns (turn, kind, question) from probe-turns.txt, so judges score the
same turns for every letter.
"""
import json, os, random, secrets, shutil, sys

run_dir, out_dir, key_file = sys.argv[1:4]
if os.path.abspath(key_file).startswith(os.path.abspath(out_dir) + os.sep): sys.exit('the key file must be outside the judges\' folder')
art = os.path.join(run_dir, 'artifacts')
configs = sorted(c for c in os.listdir(art) if os.path.isfile(os.path.join(art, c, 'turns.jsonl')))
letters = [chr(ord('A') + i) for i in range(len(configs))]
order = configs[:]; random.Random(secrets.randbits(64)).shuffle(order)
key = dict(zip(letters, order))
os.makedirs(out_dir, exist_ok=True)
for letter, config in key.items():
    d = os.path.join(out_dir, letter); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'turns.jsonl'), 'w') as out:
        for line in open(os.path.join(art, config, 'turns.jsonl')):
            r = json.loads(line); r.pop('config', None); out.write(json.dumps(r) + '\n')
    if os.path.isdir(os.path.join(art, config, 'snapshots')):
        shutil.copytree(os.path.join(art, config, 'snapshots'), os.path.join(d, 'snapshots'), dirs_exist_ok=True)
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'probe-turns.txt'), os.path.join(out_dir, 'probes.tsv'))
json.dump(key, open(key_file, 'w'), indent=1)
print(f'{len(key)} configurations blinded as {", ".join(letters)} in {out_dir}; key in {key_file} (keep it from the judges)')
