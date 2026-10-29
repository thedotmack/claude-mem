#!/usr/bin/env python3
"""Run one long Claude Code session over the Aider polyglot benchmark's Python exercises, in one arm's stack.

One session = one opening turn that sets a standing rule, then one turn per exercise (and, like Aider's benchmark, a
second try that shows the failing test output). Every turn resumes the same Claude Code session, so the conversation
grows the way a real long session does. That growth is what Endless Mode is meant to handle.

After each turn the exercise is graded with its hidden tests (the agent never sees the test files; on a second try it
sees only the failing output, as in Aider's harness). Each turn is written to the SQLite file as it finishes, so a
stopped run keeps what it measured. Costs are not computed here: extract.py reads the tees afterwards.

Usage:
  run_session.py --arm plain|endless --arm-dir DIR --bench DIR --db FILE --run-id ID [--model M] [--tries 2]
                 [--exercises a,b,c] [--limit N]
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# The standing rule, given once in the opening turn and checked in every solution file afterwards. It is not part of
# Aider's benchmark: it is how this harness checks that an early instruction is still honored late in the session.
RULE_LINE = '# Benchmark session solution'
RULE_PROMPT = (
    'In this session I will ask you to solve programming exercises, one folder at a time, in this directory. '
    'A standing rule for the whole session: the first line of every solution file you write or change must be '
    f'exactly `{RULE_LINE}`. Nothing to do yet; reply "ready".'
)

# Aider's benchmark wording (aider/benchmark/benchmark.py), with the paths adapted to one folder per exercise.
FIRST_TRY = (
    'Solve the exercise in the `{ex}/` folder. The instructions are in `{ex}/INSTRUCTIONS.md`.\n'
    'Use the instructions to modify the supplied files: {files}. '
    'Don\'t change the names of existing functions or classes, as they may be referenced from other code like unit '
    'tests, etc. Only use standard python libraries, don\'t suggest installing any packages.'
)
SECOND_TRY = (
    'The hidden tests for `{ex}/` failed:\n\n```\n{output}\n```\n\n'
    'See the testing errors above. The tests are correct, don\'t try and change them. '
    'Fix the code in {files} to resolve the errors.'
)
TEST_OUTPUT_LINES = 50  # the tail of the failing output shown on a second try (Aider shows its own trimmed output)

SCHEMA = """
CREATE TABLE IF NOT EXISTS turns (
  run_id TEXT, arm TEXT, turn_no INTEGER, kind TEXT, exercise TEXT, attempt INTEGER,
  started_at TEXT, ended_at TEXT, started_epoch REAL, ended_epoch REAL, elapsed_s REAL,
  claude_exit INTEGER, is_error INTEGER, retried INTEGER, cc_num_turns INTEGER, cc_cost_usd REAL,
  session_id TEXT, tests_passed INTEGER, tests_failed INTEGER, tests_total INTEGER, passed INTEGER,
  rule_kept INTEGER, result_text TEXT,
  PRIMARY KEY (run_id, turn_no)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, arm TEXT, model TEXT, tries INTEGER, exercises TEXT, started_at TEXT, ended_at TEXT,
  arm_dir TEXT, claude_version TEXT, notes TEXT
);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def exercise_files(ex_dir):
    cfg = json.loads((ex_dir / '.meta' / 'config.json').read_text())
    return cfg['files']['solution'], cfg['files']['test']


def prepare_project(proj, bench, exercises):
    """Copy each exercise's stub and instructions into the project; the tests stay behind in the benchmark."""
    proj.mkdir(parents=True, exist_ok=True)
    for ex in exercises:
        src = bench / ex
        dst = proj / ex
        dst.mkdir(exist_ok=True)
        solution, _ = exercise_files(src)
        for name in solution:
            shutil.copy(src / name, dst / name)
        text = (src / '.docs' / 'instructions.md').read_text()
        append = src / '.docs' / 'instructions.append.md'
        if append.exists():
            text += '\n\n' + append.read_text()
        (dst / 'INSTRUCTIONS.md').write_text(text)


def grade(proj, bench, ex, runner='pytest'):
    """Run the exercise's hidden tests against the project's current solution, in a scratch directory.

    Runs use pytest, as Aider's benchmark does. The exercises' tests are unittest classes, so runner='unittest' (the
    standard library alone) grades them the same way where pytest isn't installed.
    The solution is code the agent wrote, so it runs with a bare environment and a throwaway HOME: no credentials or
    settings of the host reach it. (It is not a sandbox; run the benchmark on a machine you would let the agent use.)
    """
    solution, tests = exercise_files(bench / ex)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(tmp), 'LANG': 'C.UTF-8',
               'PYTHONDONTWRITEBYTECODE': '1'}
        for name in solution:
            if (proj / ex / name).exists():
                shutil.copy(proj / ex / name, tmp / name)
        for name in tests:
            shutil.copy(bench / ex / name, tmp / name)
        if runner == 'pytest':
            cmd = [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', *tests]
        else:
            cmd = [sys.executable, '-m', 'unittest', *(Path(t).stem for t in tests)]
        try:
            out = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=180)
            text = out.stdout + out.stderr
        except subprocess.TimeoutExpired:
            text = 'TIMEOUT: the tests ran longer than 180 seconds'
    if runner == 'pytest':
        passed = int(m.group(1)) if (m := re.search(r'(\d+) passed', text)) else 0
        failed = sum(int(n) for n in re.findall(r'(\d+) (?:failed|error)', text))
    else:
        ran = int(m.group(1)) if (m := re.search(r'^Ran (\d+) tests?', text, re.M)) else 0
        failed = sum(int(n) for n in re.findall(r'(?:failures|errors)=(\d+)', text))
        passed = max(ran - failed, 0)
    if not passed and not failed:
        failed = 1  # import error, timeout or crash: count as a failure
    return passed, failed, text


def rule_kept(proj, bench, ex):
    solution, _ = exercise_files(bench / ex)
    for name in solution:
        path = proj / ex / name
        if not path.exists():
            return 0
        lines = path.read_text(errors='replace').splitlines()
        if not lines or lines[0].strip() != RULE_LINE:
            return 0
    return 1


REPO = Path(__file__).resolve().parents[3]


def claude_login():
    """Claude Code's current access token from your own login (read only, the tee's lookup), or None.

    Read before every turn: Claude Code rotates the token and revokes the old one. Never printed or written.
    """
    tee = REPO / 'scripts' / 'endless-mode-validation' / 'forward' / 'tee-proxy.ts'
    env = dict(os.environ)
    env.setdefault('EMV_REAL_HOME', env.get('HOME', ''))
    env.setdefault('EMV_REAL_CLAUDE_DIR', env.get('CLAUDE_CONFIG_DIR') or str(Path(env.get('HOME', '')) / '.claude'))
    env.setdefault('EMV_REAL_USER', os.environ.get('USER', ''))
    code = f"import {{ readClaudeAccessToken }} from '{tee}'; process.stdout.write(readClaudeAccessToken() ?? '')"
    try:
        out = subprocess.run([shutil.which('bun') or 'bun', '-e', code], env=env, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() or None


def claude_env(arm_dir):
    """The agent's environment: its own sandbox HOME and config dir, plus your credential.

    An API key in ANTHROPIC_API_KEY is passed on as is; otherwise your Claude Code login goes in as
    CLAUDE_CODE_OAUTH_TOKEN. With neither, the agent starts with none, which works only where the host supplies it.
    """
    keep = ['PATH', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'NODE_OPTIONS', 'LANG']
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(HOME=str(arm_dir / 'home'), CLAUDE_CONFIG_DIR=str(arm_dir / 'claude-config'), DO_NOT_TRACK='1')
    if os.environ.get('ANTHROPIC_API_KEY'):
        env['ANTHROPIC_API_KEY'] = os.environ['ANTHROPIC_API_KEY']
    elif token := claude_login():
        env['CLAUDE_CODE_OAUTH_TOKEN'] = token
    return env


def run_claude(args, arm_dir, prompt, session_id, log_base):
    cmd = [args.claude, '-p', prompt, '--model', args.model, '--output-format', 'json']
    if session_id:
        cmd += ['--resume', session_id]
    with open(f'{log_base}.json', 'w') as out, open(f'{log_base}.err', 'w') as err:
        try:
            code = subprocess.run(cmd, cwd=arm_dir / 'proj', env=claude_env(arm_dir), stdin=subprocess.DEVNULL,
                                  stdout=out, stderr=err, timeout=args.turn_timeout).returncode
        except subprocess.TimeoutExpired:
            code = -9
    try:
        data = json.loads(Path(f'{log_base}.json').read_text())
        data = data[-1] if isinstance(data, list) else data
    except Exception:
        data = {}
    return code, data


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--arm', required=True, choices=['plain', 'endless'])
    p.add_argument('--arm-label', help='name this arm in the results (default: --arm), e.g. endless-observer-haiku55')
    p.add_argument('--arm-dir', required=True, type=Path)
    p.add_argument('--bench', required=True, type=Path, help='polyglot-benchmark/python/exercises/practice')
    p.add_argument('--db', required=True, type=Path)
    p.add_argument('--run-id', required=True)
    p.add_argument('--model', default='claude-haiku-5-5')
    p.add_argument('--tries', type=int, default=2)
    p.add_argument('--exercises', default='')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--turn-timeout', type=int, default=1500)
    p.add_argument('--claude', default=shutil.which('claude'))
    args = p.parse_args()
    args.arm_dir = args.arm_dir.resolve()
    if subprocess.run([sys.executable, '-c', 'import pytest'], capture_output=True).returncode:
        sys.exit(f'{sys.executable} has no pytest; the benchmark grades with pytest (pip install pytest)')

    exercises = [e for e in args.exercises.split(',') if e] or sorted(d.name for d in args.bench.iterdir() if d.is_dir())
    if args.limit:
        exercises = exercises[:args.limit]
    proj = args.arm_dir / 'proj'
    logs = args.arm_dir / 'logs' / 'turns'
    logs.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(args.db, timeout=60)
    db.executescript(SCHEMA)
    # One run, one directory, one run id: a rerun into either would mix old turns and requests into the new run.
    if db.execute('SELECT 1 FROM runs WHERE run_id=?', (args.run_id,)).fetchone():
        sys.exit(f'run {args.run_id} is already in {args.db}; use a new run id or a new results file')
    if proj.exists() and any(proj.iterdir()):
        sys.exit(f'{proj} is not empty; use a new arm dir')
    prepare_project(proj, args.bench, exercises)
    version = subprocess.run([args.claude, '--version'], capture_output=True, text=True).stdout.strip()
    label = args.arm_label or args.arm
    db.execute('INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)',
               (args.run_id, label, args.model, args.tries, ','.join(exercises), now_iso(), None,
                str(args.arm_dir), version, None))
    db.commit()

    session_id = None
    turn_no = 0

    def turn(kind, ex, attempt, prompt):
        nonlocal session_id, turn_no
        turn_no += 1
        started_at, t0 = now_iso(), time.time()
        log_base = logs / f'{turn_no:03d}-{kind}-{ex or "rule"}-{attempt}'
        code, data = run_claude(args, args.arm_dir, prompt, session_id, log_base)
        retried = 0
        if code != 0 or data.get('is_error') or not data:
            # One retry of the same prompt on the same session (an API hiccup must not end the session).
            retried = 1
            session_id = data.get('session_id') or session_id
            code, data = run_claude(args, args.arm_dir, prompt, session_id, f'{log_base}.retry')
        t1 = time.time()
        session_id = data.get('session_id') or session_id
        row = dict(run_id=args.run_id, arm=label, turn_no=turn_no, kind=kind, exercise=ex, attempt=attempt,
                   started_at=started_at, ended_at=now_iso(), started_epoch=t0, ended_epoch=t1, elapsed_s=t1 - t0,
                   claude_exit=code, is_error=int(bool(data.get('is_error')) or not data), retried=retried,
                   cc_num_turns=data.get('num_turns'), cc_cost_usd=data.get('total_cost_usd'), session_id=session_id,
                   tests_passed=None, tests_failed=None, tests_total=None, passed=None, rule_kept=None,
                   result_text=(data.get('result') or '')[:2000])
        output = ''
        if ex:
            passed, failed, output = grade(proj, args.bench, ex)
            row.update(tests_passed=passed, tests_failed=failed, tests_total=passed + failed,
                       passed=int(failed == 0 and passed > 0), rule_kept=rule_kept(proj, args.bench, ex))
        db.execute(f'INSERT OR REPLACE INTO turns ({",".join(row)}) VALUES ({",".join("?" * len(row))})',
                   list(row.values()))
        db.commit()
        status = '' if not ex else f' tests {row["tests_passed"]}/{row["tests_total"]} rule {row["rule_kept"]}'
        print(f'{row["ended_at"]} {args.run_id} turn {turn_no} {kind} {ex} try {attempt}: '
              f'{row["elapsed_s"]:.0f}s error={row["is_error"]}{status}', flush=True)
        return row, output

    opening, _ = turn('rule', None, 0, RULE_PROMPT)
    if opening['is_error'] or not opening['session_id']:
        # Without the opening turn there is no session to continue and no standing rule: not a valid run.
        db.execute('UPDATE runs SET notes=? WHERE run_id=?', ('invalid: the opening turn failed', args.run_id))
        db.commit()
        sys.exit(f'{args.run_id}: the opening turn failed; run marked invalid')
    first_session = opening['session_id']
    for ex in exercises:
        solution, _ = exercise_files(args.bench / ex)
        files = ', '.join(f'`{ex}/{name}`' for name in solution)
        row, output = turn('task', ex, 1, FIRST_TRY.format(ex=ex, files=files))
        for attempt in range(2, args.tries + 1):
            if row['passed']:
                break
            tail = '\n'.join(output.strip().splitlines()[-TEST_OUTPUT_LINES:])
            row, output = turn('task', ex, attempt, SECOND_TRY.format(ex=ex, output=tail, files=files))

    # Every turn must have continued the opening turn's session; a turn that started a new one broke the long session.
    other = db.execute('SELECT min(turn_no) FROM turns WHERE run_id=? AND session_id != ?',
                       (args.run_id, first_session)).fetchone()[0]
    if other:
        db.execute('UPDATE runs SET notes=? WHERE run_id=?', (f'invalid: a new session started at turn {other}', args.run_id))
    db.execute('UPDATE runs SET ended_at=? WHERE run_id=?', (now_iso(), args.run_id))
    db.commit()


if __name__ == '__main__':
    main()
