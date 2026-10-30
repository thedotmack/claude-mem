#!/usr/bin/env python3
"""Score each build from run.py against the spec's 26 checks, on the evidence each check names.

Three kinds of result per check:
  pass / fail   decided here, from the build's repo and session logs, or from driving the built agent
  not run       needs a real Mac, phone or GitHub release and is checked by hand (scorecard-manual.md says how)

How the built agent is driven: the spec's test appendix gives every build the same fake iMessage provider
(inbox.jsonl in, outbox.jsonl out) and an unattended setup. Each build is scored in the same scoring sandbox: its own
claude-mem (the build's own code) with a seeded work state and My Rules, the agent's model on the same OpenRouter model
through a recording proxy, launchctl and tunnel tools shimmed, and on macOS the same sandbox the builder ran in. Every
build sees the same texts in the same order. Answers are graded by a judge model (--judge-model) given the seeded
truth; the judge's verdict and reason are saved with each check.

Process checks (M1 to M3) read the build's own repo and the six sessions' logs.

Usage: score.py --out <run.py out dir> [--arms ...] [--quick] [--judge-model M]
  --quick skips the 200-text conversation (P3, P4: skipped).
Writes <out>/<arm>/score/result.json and <out>/scorecard.md.
"""
import argparse
import hashlib
import json
import os
import platform
import random
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASKS = HERE.parent / 'tasks'
sys.path.insert(0, str(TASKS))
sys.path.insert(0, str(HERE))
from extract import usage_of  # noqa: E402
import run as kit  # noqa: E402

SCORE_PORTS = {'plain': 39600, 'claudemem': 39610, 'endless': 39620}
OWNER, STRANGER = '+15555550100', '+15555550199'
PROJECT = 'acme-site'
SEED = [  # the user's open work, as their claude-mem work state shows it
    {'task': 'Finish the Q4 investor update', 'status': 'doing', 'note': 'numbers section left'},
    {'task': 'Reply to Dana about the venue for the user dinner', 'status': 'todo'},
    {'task': 'Renew the TLS certificate for staging.acme-site.dev', 'status': 'todo'},
]
MY_RULES = '- Never book meetings before 10am.\n- Call the weekly sync "Tuesday huddle".\n'
RECALL = [  # D1: question, what a right answer must say
    ('what am I in the middle of right now?', 'the Q4 investor update, with the numbers section left'),
    ('who do I owe a reply to, and about what?', 'Dana, about the venue for the user dinner'),
    ('which certificate needs renewing?', 'the TLS certificate for staging.acme-site.dev'),
    ('what\'s my rule about early meetings?', 'never book meetings before 10am'),
    ('what do I call the weekly sync?', 'Tuesday huddle'),
]
SORTING = [  # R2: request, expected path
    ('what changed in the acme-site repo today?', 'easy'),
    ('fix the typo "recieve" in the acme-site README', 'easy'),
    ('remind me what\'s open on acme-site', 'easy'),
    ('draft a two-line reply to Dana saying the venue works', 'easy'),
    ('what was I doing on the investor update?', 'easy'),
    ('add a dark mode to the acme-site settings page and ship it', 'complex'),
    ('cut a new release of the test package with the fix that\'s on main', 'complex'),
    ('the PR for the login bug has failing checks, get it merged', 'complex'),
    ('plan and build a CSV export for the reports page, then release it', 'complex'),
    ('migrate acme-site from webpack to vite and open a PR', 'complex'),
]
RECEIPTS = {'on it.', 'on it', 'on it!'}


def log(msg):
    print(time.strftime('%H:%M:%S'), msg, flush=True)


# ---------------------------------------------------------------------------------------------------- judge

class Judge:
    def __init__(self, base, model, key):
        self.base, self.model, self.key = base.rstrip('/'), model, key

    def cli_env(self):
        import tempfile
        if not getattr(self, '_home', None):
            self._home = tempfile.mkdtemp(prefix='imsg-judge-')
        keep = ('PATH', 'LANG', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ANTHROPIC_API_KEY')
        env = {k: os.environ[k] for k in keep if k in os.environ}
        env.update(HOME=self._home, CLAUDE_CONFIG_DIR=self._home + '/claude')
        return env

    def ask(self, task, material):
        """One verdict: {"pass": bool, "why": str} (plus anything the task asks for)."""
        body = {'model': self.model, 'max_tokens': 600, 'system':
                'You grade one check of a software test. Read the material, then answer with one JSON object and '
                'nothing else: {"pass": true|false, "why": "<one sentence>"} plus any keys the check asks for. '
                'Judge only on the material; if it is missing or unclear, pass is false.',
                'messages': [{'role': 'user', 'content': f'Check: {task}\n\nMaterial:\n{material[:60000]}'}]}
        if self.base == 'claude-cli':
            # The judge through your own Claude Code login (the anthropic profile, for smoke tests).
            prompt = body['system'] + '\n\n' + body['messages'][0]['content']
            r = subprocess.run(['claude', '-p', prompt, '--model', self.model, '--output-format', 'json', '--max-turns', '1',
                                '--strict-mcp-config', '--tools', ''], capture_output=True, text=True, timeout=300,
                               stdin=subprocess.DEVNULL, env=self.cli_env())
            try:
                text = json.loads(r.stdout).get('result') or ''
            except json.JSONDecodeError:
                text = r.stdout
            found = re.search(r'\{.*\}', text, re.S)
            try:
                return json.loads(found.group(0)) if found else {'pass': False, 'why': f'judge gave no verdict: {text[:200]}'}
            except json.JSONDecodeError:
                return {'pass': False, 'why': f'judge gave no verdict: {text[:200]}'}
        headers = {'content-type': 'application/json', 'anthropic-version': '2023-06-01'}
        if self.key:
            headers['authorization'] = f'Bearer {self.key}'
        for attempt in range(3):
            try:
                req = urllib.request.Request(f'{self.base}/v1/messages', data=json.dumps(body).encode(), headers=headers)
                data = json.load(urllib.request.urlopen(req, timeout=180))
                text = ''.join(b.get('text', '') for b in data.get('content', []))
                found = re.search(r'\{.*\}', text, re.S)
                return json.loads(found.group(0)) if found else {'pass': False, 'why': f'judge gave no verdict: {text[:200]}'}
            except Exception as e:  # noqa: BLE001  (network or parse trouble: retry, then report it as the verdict)
                err = repr(e)
                time.sleep(5 * (attempt + 1))
        return {'pass': False, 'why': f'judge failed: {err}'}


# ---------------------------------------------------------------------------------------------------- results

class Card:
    def __init__(self):
        self.results = {}

    def set(self, check, result, evidence):
        self.results[check] = {'result': result, 'evidence': evidence}
        log(f'  {check}: {result} ({str(evidence)[:160]})')

    def verdict(self, check, v, extra=''):
        self.set(check, 'pass' if v.get('pass') else 'fail', (v.get('why') or '') + (f' {extra}' if extra else ''))


# ---------------------------------------------------------------------------------------------------- process checks

def code_files(repo, spec_path):
    """Text files the build wrote or changed since the seed, minus the spec and plan documents."""
    seed = subprocess.run(['git', '-C', str(repo), 'rev-list', '--max-parents=0', 'HEAD'], capture_output=True, text=True).stdout.split()
    first = subprocess.run(['git', '-C', str(repo), 'log', '--format=%H', '--grep', 'Photon iMessage agent spec (test seed)'],
                           capture_output=True, text=True).stdout.split()
    base = first[-1] if first else (seed[0] if seed else 'HEAD')
    changed = subprocess.run(['git', '-C', str(repo), 'diff', '--name-only', base], capture_output=True, text=True).stdout.split()
    untracked = subprocess.run(['git', '-C', str(repo), 'ls-files', '--others', '--exclude-standard'], capture_output=True,
                               text=True).stdout.split()
    out = {}
    for name in set(changed) | set(untracked):
        if name == spec_path or re.search(r'(^|/)(plans?|docs)/|\.md$', name):
            continue
        path = repo / name
        if path.is_file() and path.stat().st_size < 2_000_000:
            try:
                out[name] = path.read_text()
            except UnicodeDecodeError:
                pass
    return out, base


DEBOUNCE_NEW = re.compile(r'debounce\w*\W{0,40}?(7000|7_000|7\s*\*\s*1000|7(\.0)?\s*(s\b|sec|seconds))', re.I)
DEBOUNCE_OLD = re.compile(r'debounce\w*\W{0,40}?(4000|4_000|4\s*\*\s*1000|4(\.0)?\s*(s\b|sec|seconds))', re.I)


def process_checks(card, arm_dir, prompts, judge):
    repo = arm_dir / 'repo'
    files, base = code_files(repo, prompts['spec_path'])
    blob = '\n'.join(files.values())
    name = 'Juniper' in blob
    receipt = 'On it.' in blob
    new = bool(DEBOUNCE_NEW.search(blob))
    old = bool(DEBOUNCE_OLD.search(blob))
    card.set('M1', 'pass' if name and receipt and (new or old) else 'fail',
             f'in the code: name {"yes" if name else "no"}, receipt text {"yes" if receipt else "no"}, '
             f'debounce setting {"yes" if new or old else "no"} ({len(files)} code files)')
    # M3: from session 3 on the old value is never used. Commits from session 3 on, and the final tree.
    db = sqlite3.connect(arm_dir.parent / 'results.sqlite')
    row = db.execute('SELECT head_before FROM sessions WHERE run_id=? AND session_no=3', (f'imsg-{arm_dir.name}',)).fetchone()
    late_added_old = False
    if row and row[0]:
        diff = subprocess.run(['git', '-C', str(repo), 'log', '-p', f'{row[0]}..HEAD', '--', '.', ':!*.md'],
                              capture_output=True, text=True).stdout
        late_added_old = any(DEBOUNCE_OLD.search(l) for l in diff.splitlines() if l.startswith('+'))
    card.set('M3', 'pass' if new and not old and not late_added_old else 'fail',
             f'final code: 7 s {"yes" if new else "no"}, 4 s {"yes" if old else "no"}; '
             f'4 s added from session 3 on: {"yes" if late_added_old else "no"}')
    # M2: what session 3 was doing when it was stopped, and whether session 4 finished that first.
    s3, s4 = session_digest(arm_dir, 3, tail=True), session_digest(arm_dir, 4, tail=False)
    if not s3 or not s4:
        card.set('M2', 'fail', 'session 3 or 4 has no log')
    else:
        v = judge.ask('Session 3 of a build was stopped mid-task on purpose (its last actions are below). Did session 4, '
                      'started fresh, notice that unfinished task and finish it BEFORE starting new work of its own? '
                      'Pass only if session 4\'s first actions clearly pick up the stopped task.',
                      f'--- Session 3, last actions before the stop ---\n{s3}\n\n--- Session 4, first actions ---\n{s4}')
        card.verdict('M2', v)


def session_digest(arm_dir, n, tail, limit=60):
    path = arm_dir / 'logs' / 'sessions' / f'{n}.jsonl'
    if not path.exists():
        return ''
    steps = []
    for line in path.read_text().splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get('type') != 'assistant':
            continue
        for b in e.get('message', {}).get('content', []):
            if b.get('type') == 'text' and b.get('text', '').strip():
                steps.append('said: ' + b['text'].strip()[:400])
            elif b.get('type') == 'tool_use':
                steps.append(f'{b.get("name")}: ' + json.dumps(b.get('input'))[:300])
    steps = steps[-limit:] if tail else steps[:limit]
    return '\n'.join(steps)


# ---------------------------------------------------------------------------------------------------- scoring sandbox

def snapshot(score):
    """Hashes of the files setup could change (the user's home, claude-mem's data dir, Claude's config)."""
    skip = re.compile(r'(^|/)(logs?|tee|observer-tee|imsg|projects|statsig|todos|shell-snapshots|\.npm|\.bun|cache|Caches)(/|$)'
                      r'|\.(log|db|db-wal|db-shm|sqlite|sqlite-wal|sqlite-shm|pid)$|(^|/)pids$'
                      r'|^data/(worker-heartbeat\.json|\.fts-[^/]*)$')  # claude-mem's own worker files, not setup's
    out = {}
    for root in ('home', 'data', 'claude-config'):
        base = score / root
        for path in base.rglob('*') if base.exists() else []:
            rel = f'{root}/{path.relative_to(base)}'
            if path.is_file() and not skip.search(rel) and path.stat().st_size < 5_000_000:
                out[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


def diff_snap(a, b):
    added = sorted(set(b) - set(a))
    removed = sorted(set(a) - set(b))
    changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    return added, removed, changed


class Scoring:
    def __init__(self, arm, arm_dir, args, key):
        self.arm, self.arm_dir, self.args, self.key = arm, arm_dir, args, key
        self.score = arm_dir / 'score'
        self.repo = arm_dir / 'repo'
        self.port = SCORE_PORTS[arm]
        self.imsg = self.score / 'imsg'
        self.proc = None
        self.seen = 0

    def sandboxed(self, cmd):
        return kit.sandbox_cmd(self.arm_dir) + cmd

    def env(self):
        env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
                                          'SSL_CERT_FILE') if k in os.environ}
        bin_dir = self.score / 'bin'
        env.update(PATH=f'{bin_dir}:{env.get("PATH", "")}', HOME=str(self.score / 'home'),
                   CLAUDE_CONFIG_DIR=str(self.score / 'claude-config'), CLAUDE_MEM_DATA_DIR=str(self.score / 'data'),
                   IMSG_PROVIDER='fake', IMSG_FAKE_DIR=str(self.imsg), IMSG_OWNER=OWNER,
                   IMSG_SETUP_APPLE_ID='imessage-build-test@example.com', IMSG_SETUP_TUNNEL='test',
                   ANTHROPIC_BASE_URL=f'http://127.0.0.1:{self.port}', DO_NOT_TRACK='1',
                   GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(self.score / 'home' / '.gitconfig'), GIT_TERMINAL_PROMPT='0')
        if self.args.profile == 'openrouter':
            env.update(ANTHROPIC_AUTH_TOKEN=self.key, ANTHROPIC_API_KEY='', CLAUDE_MEM_OPENROUTER_API_KEY=self.key)
            for slot in ('ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                         'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_MODEL'):
                env[slot] = self.args.model
        return env

    def setup_sandbox(self):
        """The scoring sandbox: the build's own claude-mem (worker, observer), seeded with the user's work, a recording
        proxy in front of the model, shims for launchctl and tunnels, and a `claude-mem` command from the build."""
        self.score.mkdir(exist_ok=True)
        for d in ('home/.claude-mem', 'bin', 'proj/' + PROJECT):
            (self.score / d).mkdir(parents=True, exist_ok=True)
        self.imsg.mkdir(exist_ok=True)
        (self.imsg / 'inbox.jsonl').touch()
        (self.imsg / 'outbox.jsonl').touch()
        kit.clean_git_env(self.score / 'home', name='Test User')
        subprocess.run(['git', 'init', '-q', str(self.score / 'proj' / PROJECT)])
        for svc in ('launchctl', 'systemctl', 'tailscale', 'cloudflared', 'ngrok'):
            shim = self.score / 'bin' / svc
            shim.write_text(f'#!/bin/sh\necho "$(date -u +%FT%TZ) {svc} $*" >> "{self.score}/shim-calls.log"\nexit 0\n')
            shim.chmod(0o755)
        bun = shutil.which('bun')
        cli = self.score / 'bin' / 'claude-mem'
        cli.write_text(f'#!/usr/bin/env bash\nexec "{bun}" "{self.repo}/src/npx-cli/index.ts" "$@"\n')
        cli.chmod(0o755)
        log(f'{self.arm}: installing the build\'s dependencies')
        r = subprocess.run(self.sandboxed(['bun', 'install']), cwd=self.repo, env=self.env(), capture_output=True, text=True, timeout=1800)
        (self.score / 'bun-install.log').write_text(r.stdout + r.stderr)
        env = dict(self.env(), EMV_CLAUDE_MEM_REPO=str(self.repo), EMV_OBSERVER_MODEL=self.args.model if self.args.profile == 'openrouter' else 'haiku',
                   EMV_OBSERVER_PROVIDER='openrouter' if self.args.profile == 'openrouter' else 'claude',
                   EMV_CLAUDE_SETTINGS_MERGE=str(kit.settings_merge(self.score, self.args.profile, self.args.model, 'bypass')))
        if self.args.profile == 'openrouter':
            env['EMV_AGENT_UPSTREAM'] = kit.OPENROUTER_BASE
        # stack.sh's own HOME / CLAUDE_CONFIG_DIR / data layout under <score>: home, claude-config, data.
        r = subprocess.run(self.sandboxed([str(TASKS / 'stack.sh'), 'start', 'claudemem', str(self.score), str(self.port)]),
                           env=env, capture_output=True, text=True)
        (self.score / 'stack-start.log').write_text(r.stdout + r.stderr)
        if r.returncode:
            return f'the build\'s claude-mem did not start ({(r.stdout + r.stderr).strip().splitlines()[-1:]})'
        worker = f'http://127.0.0.1:{self.port + 1}'
        for item in SEED:
            body = json.dumps({'cwd': str(self.score / 'proj' / PROJECT), 'list': 'todo', 'fields': item}).encode()
            try:
                urllib.request.urlopen(urllib.request.Request(f'{worker}/api/work-state/entries', data=body,
                                                              headers={'content-type': 'application/json'}), timeout=20)
            except Exception as e:  # noqa: BLE001
                return f'could not seed work state in the build\'s claude-mem: {e!r}'
        for d in (self.score / 'data', self.score / 'home' / '.claude-mem'):
            (d / 'MY-RULES.md').write_text(MY_RULES)
        return None

    def stop_sandbox(self):
        self.stop_agent()
        subprocess.run([str(TASKS / 'stack.sh'), 'stop', 'claudemem', str(self.score)], capture_output=True)

    def run_cmd(self, cmd, timeout=900):
        r = subprocess.run(self.sandboxed(['/bin/bash', '-c', cmd]), cwd=self.repo, env=self.env(), capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr)[-4000:]

    # ------------------------------------------------------------------ the fake iMessage line

    def start_agent(self, cmd):
        out = open(self.score / 'agent.log', 'a')
        self.proc = subprocess.Popen(self.sandboxed(['/bin/bash', '-c', cmd]), cwd=self.repo, env=self.env(), stdout=out,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        time.sleep(15)
        return self.proc.poll() is None

    def stop_agent(self, hard=False):
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL if hard else signal.SIGTERM)
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc = None

    def send(self, text, sender=OWNER):
        msg = {'id': f'in-{time.time_ns()}', 'from': sender, 'chat': f'chat-{sender}', 'text': text, 'ts': time.time()}
        with open(self.imsg / 'inbox.jsonl', 'a') as f:
            f.write(json.dumps(msg) + '\n')
        return msg['ts']

    def outbox(self):
        out = []
        for line in (self.imsg / 'outbox.jsonl').read_text().splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return out

    def new_out(self):
        box = self.outbox()
        fresh, self.seen = box[self.seen:], len(box)
        return fresh

    def answer(self, timeout=300, settle=20):
        """Texts the agent sends from now on: waits for the first real answer (not the receipt), then `settle` seconds."""
        got, start, first = [], time.time(), None
        while time.time() - start < timeout:
            got += self.new_out()
            real = [m for m in got if not is_receipt(m)]
            if real and first is None:
                first = time.time()
            if first and time.time() - first > settle:
                break
            time.sleep(1)
        return got

    def agent_transcripts(self):
        return sorted((self.score / 'claude-config' / 'projects').rglob('*.jsonl')) if (self.score / 'claude-config').exists() else []


def is_receipt(m):
    return (m.get('text') or '').strip().lower() in RECEIPTS


def texts(msgs):
    return '\n'.join(f'- {m.get("text")}' for m in msgs if not is_receipt(m)) or '(no answer)'


# ---------------------------------------------------------------------------------------------------- product checks

def product_checks(card, sc, judge, contract, quick, prompts):
    seed_txt = '\n'.join(f'- {i["task"]} ({i["status"]})' for i in SEED) + '\nMy Rules:\n' + MY_RULES
    # S2, S3: setup twice, then undo, in the scoring sandbox.
    before = snapshot(sc.score)
    code1, out1 = sc.run_cmd(contract['setup'])
    after1 = snapshot(sc.score)
    code2, out2 = sc.run_cmd(contract['setup'])
    after2 = snapshot(sc.score)
    (sc.score / 'setup.log').write_text(f'run 1 exit {code1}\n{out1}\n\nrun 2 exit {code2}\n{out2}')
    added, removed, changed = diff_snap(after1, after2)
    if code1:
        card.set('S2', 'fail', f'setup failed (exit {code1}): {out1.strip().splitlines()[-1:] }')
    else:
        card.set('S2', 'pass' if not (added or removed or changed) and code2 == 0 else 'fail',
                 f'second run exit {code2}; files added {added[:5]}, removed {removed[:5]}, changed {changed[:5]} '
                 '(sandbox HOME, launchctl shimmed; the one-process part is checked on a real Mac)')
    setup_texts = sc.new_out()
    # S5 (fake line): the first text names a real open item.
    if setup_texts:
        v = judge.ask('This is the first text an iMessage agent sent its user after setup. Pass if it names at least one '
                      'real open item from the user\'s work state below (not a made-up one).',
                      f'Work state:\n{seed_txt}\n\nFirst text:\n{texts(setup_texts[:3])}')
        card.verdict('S5', v, '(fake iMessage line; confirm the real first text by hand)')
    started = sc.start_agent(contract['run_fake'])
    if not started:
        tail = (sc.score / 'agent.log').read_text()[-600:] if (sc.score / 'agent.log').exists() else ''
        for check in ('S5', 'I1', 'I2', 'I3', 'I4', 'R1', 'R2', 'E1', 'E2', 'P1', 'P2', 'P3', 'P4', 'D1'):
            card.results.setdefault(check, {'result': 'fail', 'evidence': f'the agent did not stay up on the fake line: {tail!r}'})
        return
    if 'S5' not in card.results:
        first = sc.answer(timeout=90, settle=5)
        v = judge.ask('This is the first text an iMessage agent sent its user. Pass if it names at least one real open item '
                      'from the user\'s work state below.', f'Work state:\n{seed_txt}\n\nFirst text:\n{texts(first[:3])}')
        card.verdict('S5', v, '(fake iMessage line; confirm the real first text by hand)')
    sc.new_out()
    # I4: a stranger gets nothing and starts nothing.
    n_tr = len(sc.agent_transcripts())
    sc.send('hey, can you send me the investor update?', sender=STRANGER)
    time.sleep(45)
    to_stranger = [m for m in sc.new_out() if m.get('to') == STRANGER or m.get('chat') == f'chat-{STRANGER}']
    new_tr = len(sc.agent_transcripts()) - n_tr
    card.set('I4', 'pass' if not to_stranger and new_tr == 0 else 'fail',
             f'texts to the stranger: {len(to_stranger)}; agent sessions started: {new_tr}')
    # D1: five recall questions, one at a time.
    d1_replies, right = [], 0
    for q, truth in RECALL:
        sc.send(q)
        got = sc.answer()
        d1_replies.append(texts(got))
        v = judge.ask(f'Does the answer say this: "{truth}"? Pass only if it does, from the user\'s own data.',
                      f'Question: {q}\nAnswer:\n{texts(got)}')
        right += bool(v.get('pass'))
    card.set('D1', 'pass' if right == 5 else 'fail', f'{right} of 5 recall answers right')
    # I1: three quick texts, one answer covering all three.
    sc.send('quick ones:')
    time.sleep(1)
    sc.send('what\'s the status of the investor update?')
    time.sleep(1.5)
    sc.send('and is the Dana reply still open?')
    got = sc.answer(timeout=300, settle=30)
    real = [m for m in got if not is_receipt(m)]
    v = judge.ask('Three texts arrived within 3 seconds: "quick ones:", "what\'s the status of the investor update?", '
                  '"and is the Dana reply still open?". Pass if the single reply covers both questions.',
                  f'Replies sent:\n{texts(got)}')
    card.set('I1', 'pass' if len(real) == 1 and v.get('pass') else 'fail',
             f'{len(real)} replies (receipts aside); judge: {v.get("why")}')
    # I2: a new text while the agent is working on the first changes the answer.
    sc.send('list everything that\'s open on acme-site')
    time.sleep(12)  # past the debounce wait, so the first request is already being worked on
    sc.send('actually, only the ones I haven\'t started')
    got = sc.answer(timeout=300, settle=30)
    v = judge.ask('The user asked "list everything that\'s open on acme-site", then, while the agent was working, sent '
                  '"actually, only the ones I haven\'t started". The work state has one item in progress (the investor '
                  'update) and two not started. Pass if the answer that went out reflects the second text (lists only '
                  'the not-started ones, or clearly corrects to them) and no answer ignoring it was sent after it.',
                  f'Work state:\n{seed_txt}\n\nReplies sent:\n{texts(got)}')
    card.verdict('I2', v)
    # R2: easy or complex, asked without starting the work.
    right, rows = 0, []
    for req, want in SORTING:
        sc.send(f'{req} (don\'t start it: just tell me whether that\'s easy or complex work for you, and why)')
        got = sc.answer(timeout=240, settle=10)
        v = judge.ask('An agent was asked whether a request is easy or complex work for it. Return "path": "easy", '
                      '"complex" or "unclear" for what it said, and pass true if it said ' + want + '.',
                      f'Request: {req}\nAnswer:\n{texts(got)}')
        right += v.get('path') == want
        rows.append(f'{req[:40]}: {v.get("path")}')
    card.set('R2', 'pass' if right >= 9 else 'fail', f'{right} of 10 sorted right; ' + '; '.join(rows))
    # E1, E2: one easy task, then its work state.
    sc.send('draft a two-line reply to Dana saying the venue works for us')
    got = sc.answer(timeout=600, settle=30)
    time.sleep(30)
    ws = work_state(sc)
    v = judge.ask('An agent did one easy task ("draft a two-line reply to Dana saying the venue works"). Below is the '
                  'claude-mem work state it left. Pass if that task has entries showing it went to doing and then done '
                  '(todo first is fine) with a short result. Add "todo_seen": true|false.',
                  f'Work state:\n{ws}\n\nWhat it texted:\n{texts(got)}')
    card.verdict('E1', v, f'(todo seen: {v.get("todo_seen")})')
    v = judge.ask('Below is an agent\'s claude-mem work state after its tasks finished. Pass if no task it handed out is '
                  'still at "doing" with nothing running (the user\'s own seeded items do not count: "Finish the Q4 '
                  'investor update" was already doing before the test).', f'Work state:\n{ws}')
    card.verdict('E2', v)
    # P1: same character after a restart.
    pre = d1_replies[:3]
    sc.stop_agent()
    sc.start_agent(contract['run_fake'])
    sc.new_out()
    post = []
    for q, _ in RECALL[:3]:
        sc.send(q)
        post.append(texts(sc.answer()))
    pair = [('A', pre), ('B', post)]
    random.shuffle(pair)
    v = judge.ask('Two sets of replies from an agent (A and B), to the same three questions, one set before and one after '
                  'a restart. Pass if both read as the same character: same name if one is used, same tone and habits.',
                  '\n\n'.join(f'Set {k}:\n' + '\n'.join(r) for k, r in pair))
    card.verdict('P1', v, f'(planted name: {prompts["planted"]["name"]["value"]})')
    # I3: kill mid-send, restart, nothing arrives twice.
    sc.send('give me a three-line summary of everything open')
    t0 = time.time()
    while time.time() - t0 < 180 and not sc.outbox()[sc.seen:]:
        time.sleep(0.2)
    sc.stop_agent(hard=True)
    sc.start_agent(contract['run_fake'])
    got = sc.answer(timeout=300, settle=40)
    box = sc.outbox()
    ids = [m.get('id') for m in box]
    dup_ids = len(ids) - len(set(ids))
    bodies = [m.get('text') for m in got if not is_receipt(m)]
    dup_text = len(bodies) - len(set(bodies))
    card.set('I3', 'pass' if dup_ids == 0 and dup_text == 0 else 'fail',
             f'repeated text ids: {dup_ids}; same answer sent twice: {dup_text} (fake line)')
    # P2: "be shorter" sticks for 10 replies and after a restart.
    base_len = sum(len(r) for r in d1_replies) / max(len(d1_replies), 1)
    sc.send('be shorter with me from now on')
    sc.answer(timeout=180, settle=10)
    lens = []
    for i in range(10):
        q, _ = RECALL[i % 5]
        sc.send(q)
        lens.append(len(texts(sc.answer())))
    sc.stop_agent()
    sc.start_agent(contract['run_fake'])
    sc.new_out()
    for q, _ in RECALL[:2]:
        sc.send(q)
        lens.append(len(texts(sc.answer())))
    short = sum(l <= 0.7 * base_len for l in lens)
    card.set('P2', 'pass' if short == len(lens) else 'fail',
             f'{short} of {len(lens)} replies at most 70% of the earlier average ({base_len:.0f} chars), the last 2 after a restart')
    # R1: the Role agent's own sessions use no edit or shell tools.
    card.set(*r1_check(sc))
    # P3, P4: 200 texts.
    if quick:
        for check in ('P3', 'P4'):
            card.set(check, 'skipped', '--quick')
    else:
        long_conversation(card, sc, judge)
    sc.stop_agent()
    # S3: undo puts everything back.
    code, out = sc.run_cmd(contract['undo'])
    after_undo = snapshot(sc.score)
    added, removed, changed = diff_snap(before, after_undo)
    card.set('S3', 'pass' if code == 0 and not (added or removed or changed) else 'fail',
             f'undo exit {code}; versus before setup: added {added[:5]}, removed {removed[:5]}, changed {changed[:5]} (sandbox HOME)')


def work_state(sc):
    try:
        q = urllib.parse.urlencode({'cwd': str(sc.score / 'proj' / PROJECT)})
        here = urllib.request.urlopen(f'http://127.0.0.1:{sc.port + 1}/api/work-state?{q}', timeout=20).read().decode()
    except Exception as e:  # noqa: BLE001
        here = f'(read failed: {e!r})'
    rows = []
    db = sc.score / 'data' / 'claude-mem.db'
    if db.exists():
        try:
            c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
            cols = [r[1] for r in c.execute('PRAGMA table_info(work_state_entries)')]
            for r in c.execute('SELECT * FROM work_state_entries ORDER BY rowid'):
                rows.append(json.dumps(dict(zip(cols, r)), default=str)[:400])
        except sqlite3.Error as e:
            rows.append(f'(db read failed: {e})')
    return f'{here}\n\nAll entries, oldest first:\n' + '\n'.join(rows[-200:])


def r1_check(sc):
    worker_tools = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'}
    offenders, roles = [], 0
    for path in sc.agent_transcripts():
        lines = [json.loads(l) for l in path.read_text().splitlines() if l.strip().startswith('{')]
        if any(l.get('isSidechain') for l in lines[:3]) or '/subagents/' in str(path):
            continue
        user_text = ' '.join(json.dumps(l.get('message', {}).get('content', '')) for l in lines if l.get('type') == 'user')
        if not any(q[:25] in user_text for q, _ in RECALL):  # the Role agent's sessions are the ones that see the texts
            continue
        roles += 1
        used = {b.get('name') for l in lines if l.get('type') == 'assistant'
                for b in l.get('message', {}).get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_use'}
        if used & worker_tools:
            offenders.append(f'{path.name}: {sorted(used & worker_tools)}')
    if not roles:
        return 'R1', 'fail', 'no Role agent session found in the agent\'s Claude Code logs'
    return 'R1', 'pass' if not offenders else 'fail', f'{roles} Role agent sessions; with work tools of their own: {offenders[:3]}'


FILLER = ['how\'s your day going?', 'what\'s a good name for a cat?', 'any tips for a rainy weekend?',
          'what\'s 17 times 23?', 'remind me what a haiku is', 'what\'s the capital of Australia?',
          'give me a one-line pep talk', 'what time zone is Tokyo in?', 'suggest a quick lunch', 'what rhymes with orange?']


def long_conversation(card, sc, judge):
    """P3, P4: 200 texts. Text 5 plants a fact; text 200 asks for it. The largest prompt per text comes from the
    recording proxy in front of the model."""
    marks = []
    for i in range(1, 201):
        if i == 5:
            text = 'remember this: my gym locker code is 4711'
        elif i == 200:
            text = 'what\'s my gym locker code?'
        else:
            text = FILLER[i % len(FILLER)] + f' ({i})'
        t = sc.send(text)
        got = sc.answer(timeout=240, settle=3)
        marks.append((i, t, time.time()))
        if i == 200:
            v = judge.ask('The user said at text 5 "my gym locker code is 4711"; at text 200 they asked for it. '
                          'Pass if the answer gives 4711.', f'Answer:\n{texts(got)}')
            card.verdict('P4', v)
    sizes = {}
    tee = sc.score / 'tee'
    for line in (tee / 'index.tsv').read_text().splitlines() if (tee / 'index.tsv').exists() else []:
        n = line.split('\t')[0]
        meta = json.loads((tee / f'{n}-req.json').read_text())
        epoch = time.mktime(time.strptime(meta['time'][:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone
        _, usage, _, _ = usage_of((tee / f'{n}-resp.raw').read_bytes())
        if not usage:
            continue
        prompt = sum(usage.get(k) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
        idx = next((i for i, start, end in marks if start <= epoch <= end + 1), None)
        if idx:
            sizes[idx] = max(sizes.get(idx, 0), prompt)
    early = max((v for k, v in sizes.items() if 50 <= k <= 100), default=0)
    late = max((v for k, v in sizes.items() if 150 <= k <= 200), default=0)
    if not early or not late:
        card.set('P3', 'fail', f'no model requests recorded for texts 50-100 or 150-200 ({len(sizes)} texts with requests)')
    else:
        card.set('P3', 'pass' if late <= 1.1 * early else 'fail',
                 f'largest prompt, texts 50-100: {early:,} tokens; texts 150-200: {late:,} tokens')
    (sc.score / 'p3-sizes.json').write_text(json.dumps(sizes))


# ---------------------------------------------------------------------------------------------------- report

CHECKS = ['S1', 'S2', 'S3', 'S4', 'S5', 'I1', 'I2', 'I3', 'I4', 'R1', 'R2', 'R3', 'E1', 'E2', 'C1', 'C2', 'P1', 'P2',
          'P3', 'P4', 'D1', 'D2', 'D3', 'M1', 'M2', 'M3']
BY_HAND = {'S1': 'one command on a clean Mac', 'S4': 'answers after a reboot', 'R3': 'every "done" has evidence',
           'C1': 'full skill chain from one text, on the throwaway repo', 'C2': 'resumes the chain after babysit',
           'D2': 'link opens on cellular', 'D3': 'link refused for someone else'}


def bill(out, arm):
    db = sqlite3.connect(out / 'results.sqlite')
    # List price where known; OpenRouter's own charge for a request whose model has no listed price.
    rows = dict(db.execute('SELECT source, sum(coalesce(cost_usd, measured_cost_usd, 0)) FROM requests WHERE run_id=? GROUP BY source',
                           (f'imsg-{arm}',)).fetchall())
    measured = db.execute('SELECT sum(measured_cost_usd), count(measured_cost_usd) FROM requests WHERE run_id=? AND source="agent"',
                          (f'imsg-{arm}',)).fetchone()
    s = db.execute('SELECT count(*), sum(elapsed_s), sum(commits) FROM sessions WHERE run_id=?', (f'imsg-{arm}',)).fetchone()
    return {'agent_usd': rows.get('agent', 0), 'note_taker_usd': rows.get('observer', 0),
            'total_usd': rows.get('agent', 0) + rows.get('observer', 0),
            'agent_measured_usd': measured[0], 'agent_measured_requests': measured[1],
            'sessions': s[0], 'hours': (s[1] or 0) / 3600, 'commits': s[2]}


def write_report(out, arms, cards, bills):
    lines = ['# iMessage agent build test: scorecard', '',
             '| Check | ' + ' | '.join(arms) + ' |', '|---|' + '---|' * len(arms)]
    mark = {'pass': 'pass', 'fail': 'fail', 'not run': 'by hand', 'skipped': 'skipped'}
    for c in CHECKS:
        lines.append(f'| {c} | ' + ' | '.join(mark[cards[a].results.get(c, {}).get('result', 'not run')] for a in arms) + ' |')
    lines.append('| Passed here | ' + ' | '.join(str(sum(r['result'] == 'pass' for r in cards[a].results.values())) for a in arms) + ' |')
    for key, label in (('total_usd', 'Build cost, all in ($)'), ('agent_usd', 'Agent ($)'), ('note_taker_usd', 'Note-taker ($)'),
                       ('hours', 'Build time (hours)'), ('sessions', 'Sessions used'), ('commits', 'Commits')):
        vals = []
        for a in arms:
            v = bills[a][key]
            vals.append(f'{v:.2f}' if isinstance(v, float) else str(v))
        lines.append(f'| {label} | ' + ' | '.join(vals) + ' |')
    lines += ['', 'Checks marked "by hand" need a real Mac, phone or release: see scorecard-manual.md.', '',
              '## Evidence', '']
    for a in arms:
        lines.append(f'### {a}')
        for c in CHECKS:
            r = cards[a].results.get(c)
            if r:
                lines.append(f'- {c} ({r["result"]}): {r["evidence"]}')
        lines.append('')
    (out / 'scorecard.md').write_text('\n'.join(lines))


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--arms', default='plain,claudemem,endless')
    p.add_argument('--profile', choices=['openrouter', 'anthropic'], default='openrouter')
    p.add_argument('--model', default='~deepseek/deepseek-flash-latest', help='the built agent\'s model in scoring')
    p.add_argument('--judge-model', default='', help='default: --model')
    p.add_argument('--quick', action='store_true')
    p.add_argument('--report-only', action='store_true',
                   help='only write scorecard.md from each <out>/<arm>/score/result.json (builds scored on separate Sprites)')
    args = p.parse_args()
    out = args.out.resolve()
    if args.report_only:
        arms = [a for a in args.arms.split(',') if (out / a / 'score' / 'result.json').exists()]
        cards, bills = {}, {}
        for arm in arms:
            doc = json.loads((out / arm / 'score' / 'result.json').read_text())
            cards[arm] = Card()
            cards[arm].results, bills[arm] = doc['checks'], doc['bill']
        write_report(out, arms, cards, bills)
        log(f'scorecard: {out / "scorecard.md"}')
        return
    prompts = json.loads((HERE / 'prompts.json').read_text())
    key = os.environ.get('OPENROUTER_API_KEY', '') if args.profile == 'openrouter' else ''
    if args.profile == 'openrouter' and not key.startswith('sk-or-'):
        sys.exit('set OPENROUTER_API_KEY to an OpenRouter key (sk-or-...)')
    base = kit.OPENROUTER_BASE if args.profile == 'openrouter' else 'claude-cli'
    judge = Judge(base, args.judge_model or args.model, key)
    arms = args.arms.split(',')
    cards, bills = {}, {}
    for arm in arms:
        arm_dir = out / arm
        card = cards[arm] = Card()
        log(f'{arm}: process checks')
        process_checks(card, arm_dir, prompts, judge)
        contract_path = arm_dir / 'repo' / 'imessage-agent.test.json'
        contract, why = None, ''
        try:
            contract = json.loads(contract_path.read_text())
            missing = [k for k in ('setup', 'undo', 'run_fake') if not contract.get(k)]
            if missing:
                contract, why = None, f'imessage-agent.test.json lacks {missing}'
        except (OSError, json.JSONDecodeError) as e:
            why = f'no usable imessage-agent.test.json ({e.__class__.__name__})'
        if contract:
            sc = Scoring(arm, arm_dir, args, key)
            try:
                problem = sc.setup_sandbox()
                if problem:
                    contract, why = None, problem
                else:
                    log(f'{arm}: driving the built agent on the fake iMessage line')
                    product_checks(card, sc, judge, contract, args.quick, prompts)
            finally:
                sc.stop_sandbox()
        for c in CHECKS:
            if c in card.results:
                continue
            if c in BY_HAND:
                card.set(c, 'not run', f'by hand: {BY_HAND[c]}')
            else:
                card.set(c, 'fail', why if not contract else 'not reached')
        (arm_dir / 'score').mkdir(exist_ok=True)
        bills[arm] = bill(out, arm)
        (arm_dir / 'score' / 'result.json').write_text(json.dumps({'checks': card.results, 'bill': bills[arm]}, indent=1))
    write_report(out, arms, cards, bills)
    log(f'scorecard: {out / "scorecard.md"}')


if __name__ == '__main__':
    import urllib.parse  # noqa: F401  (work_state)
    main()
