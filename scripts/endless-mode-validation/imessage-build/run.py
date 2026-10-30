#!/usr/bin/env python3
"""Have a coding agent build the Photon iMessage agent spec three ways, six fresh sessions each, side by side.

Arms (the same agent model, prompts and starting commit in all three; only the memory setup differs):
  plain      Claude Code alone (claude-mem fully off)
  claudemem  regular claude-mem, no Wire Gateway: claude-mem's own hooks plus its MCP tools (search, work state)
  endless    Claude Code through the Wire Gateway with memory injection, the durable header and Endless Mode on, plus
             claude-mem's MCP tools

Each arm builds in its own clone of feat/wire-gateway with the spec committed on top (docs/specs/...). The clone's
`origin` is a local bare repo, so nothing is pushed to GitHub. Every session starts fresh (no --resume) with the same
one-line prompt; session 1 also plants three decisions, session 2 reverses one, and session 3 is stopped on purpose
after a fixed number of tool calls (prompts.json). The three arms get the same five claude-mem skills (make-plan, do,
babysit, version-bump, childhood) as user skills, so the skills are no difference between them.

Safety, on macOS: every builder session runs under sandbox-exec (sandbox.sb). It cannot read the Messages database,
run osascript or send AppleEvents (so no text can go out from a real Apple ID), cannot write anywhere in your home
outside its own run dir, and cannot read your SSH, GitHub, npm, Claude or claude-mem credentials. A preflight runs
probes inside the sandbox and stops before any session if one of them gets through. Git runs without your system and
global git config, so no keychain credential is offered to GitHub. Test packages go to a local registry (Verdaccio)
started per arm; GitHub is used only for throwaway repos you name in TEST_GH_REPO_PREFIX, with a token you scope to them.

Cost: every request is recorded by the arm's proxies (the agent's, and the note-taker's) and priced afterwards
(../tasks/extract.py; DeepSeek at OpenRouter's listed prices, fetched at extract time, plus OpenRouter's own
usage.cost where it sends one). The note-taker runs on claude-mem's claude provider with the newest Haiku: 'haiku'
through your Claude login, or (--notetaker openrouter, on a box with no Claude login) OpenRouter's newest-Haiku alias,
through the same recording proxy either way, so its cost is in the bill.

Safety, on Linux (a Fly Sprite, see sprites.sh): the builder runs under bubblewrap, with the filesystem read-only except
its run dir and the real home's credential files hidden; the same probes check no GitHub or npm login is reachable.

Usage: see README.md. Results: <out>/results.sqlite (sessions, turns, requests), logs under <out>/<arm>/.
"""
import argparse
import json
import os
import platform
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TASKS = HERE.parent / 'tasks'
REPO = HERE.parent.parent.parent
sys.path.insert(0, str(TASKS))
from run_session import open_db  # noqa: E402  (the task benchmark's turns/runs schema, which extract.py reads)

PORTS = {'plain': 39500, 'claudemem': 39510, 'endless': 39520}
SKILLS = ['make-plan', 'do', 'babysit', 'version-bump', 'childhood']
OPENROUTER_BASE = os.environ.get('EMV_OPENROUTER_BASE', 'https://openrouter.ai/api')  # override: tests only
VERDACCIO = 'verdaccio@6.10.4'
NEWEST_HAIKU_OPENROUTER = '~anthropic/claude-haiku-latest'  # OpenRouter's always-newest alias, never a dated id

SESSIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  run_id TEXT, arm TEXT, session_no INTEGER, prompt TEXT, started_at TEXT, ended_at TEXT, started_epoch REAL,
  ended_epoch REAL, elapsed_s REAL, exit_code INTEGER, stopped TEXT, tool_calls INTEGER, cc_num_turns INTEGER,
  cc_cost_usd REAL, session_id TEXT, result_text TEXT, head_before TEXT, head_after TEXT, commits INTEGER,
  test_json TEXT, PRIMARY KEY (run_id, session_no)
);
"""


def check_openrouter_model(model, key, who):
    """One tiny request, so a wrong model name or key stops the run before anything is built."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f'{OPENROUTER_BASE}/v1/messages', method='POST', data=json.dumps(
        {'model': model, 'max_tokens': 1, 'messages': [{'role': 'user', 'content': 'hi'}]}).encode(),
        headers={'authorization': f'Bearer {key}', 'content-type': 'application/json', 'anthropic-version': '2023-06-01'})
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        sys.exit(f'OpenRouter refused {who}\'s model {model!r} ({e.code}): {e.read()[:300].decode(errors="replace")}')
    except OSError as e:
        sys.exit(f'could not reach OpenRouter for {who} ({e})')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def sh(cmd, check=True, **kw):
    r = subprocess.run(cmd, text=True, capture_output=True, **kw)
    if check and r.returncode:
        sys.exit(f'failed ({r.returncode}): {" ".join(map(str, cmd))}\n{r.stdout}{r.stderr}')
    return r


def log(msg):
    print(f'{now()} {msg}', flush=True)


# ---------------------------------------------------------------------------------------------------- sandbox

def sandbox_profile(arm_dir, real_home):
    """The macOS sandbox for the builder: everything allowed except what could reach Messages, your credentials or
    your files outside the run dir. Later rules win in a sandbox profile, so the run dir's allow comes last."""
    secrets = SECRETS + ['Library/Keychains', 'Library/Messages', 'Library/Application Support/Claude']
    deny_read = '\n'.join(f'  (subpath "{real_home}/{p}")' for p in secrets)
    return f""";; claude-mem imessage-build: builder sandbox (generated by run.py)
(version 1)
(allow default)
;; No Messages: no database read, no osascript or Shortcuts, no AppleEvents to any app.
(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/shortcuts") (literal "/usr/bin/automator"))
;; No real background services: launchctl is checked on a real Mac by hand (the scorer shims it).
(deny process-exec (literal "/bin/launchctl"))
;; No real tunnels: tailscale, cloudflared and ngrok could change your real network setup.
(deny process-exec (regex #"/(tailscale|Tailscale|cloudflared|ngrok)$"))
(deny appleevent-send)
;; No keychain: nothing stored there (Claude, GitHub or other logins) can be read through the security service.
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))
;; No credentials or Messages data from the real home.
(deny file-read* file-write*
{deny_read})
;; No writes in the real home ...
(deny file-write* (subpath "{real_home}"))
;; ... except this arm's own run dir.
(allow file-write* (subpath "{arm_dir}"))
"""


# On Linux (a Fly Sprite or another throwaway box) the builder runs under bubblewrap: the whole filesystem read-only
# except this arm's run dir, its own /tmp inside the run dir, and the real home's credential files hidden. There are no
# Messages or launchd on Linux, so those blocks have nothing to block; the probes still check them.
SECRETS = ['.ssh', '.aws', '.gnupg', '.docker', '.config/gh', '.npmrc', '.netrc', '.gitconfig', '.git-credentials',
           '.claude', '.claude.json', '.claude-mem', '.codex', '.config/sprites', '.sprites', '.config/gcloud', '.emv']
REAL_HOME = Path(os.environ.get('HOME', '/')).resolve()
_BWRAP = None


def bwrap_works():
    global _BWRAP
    if _BWRAP is None:
        _BWRAP = bool(shutil.which('bwrap')) and subprocess.run(
            ['bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', 'true'],
            capture_output=True).returncode == 0
    return _BWRAP


def sandbox_cmd(arm_dir):
    if platform.system() == 'Darwin':
        return ['sandbox-exec', '-f', str(arm_dir / 'sandbox.sb')]
    if not bwrap_works():
        return []
    tmp = arm_dir / 'tmp'
    tmp.mkdir(exist_ok=True)
    cmd = ['bwrap', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--bind', str(tmp), '/tmp',
           '--setenv', 'TMPDIR', '/tmp']
    for rel in SECRETS:
        rel = '.claude/.credentials.json' if rel == '.claude' else rel  # Claude Code itself may be installed there
        path = REAL_HOME / rel
        if path.is_dir():
            cmd += ['--tmpfs', str(path)]
        elif path.exists():
            cmd += ['--ro-bind', '/dev/null', str(path)]
    return cmd + ['--bind', str(arm_dir), str(arm_dir)]


def preflight_sandbox(arm_dir, env, real_home):
    """Probes inside the sandbox. Every 'must fail' has to fail and every 'must work' has to work, or nothing runs."""
    no_token = {k: v for k, v in env.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN')}
    released = {  # on every platform: no login that could push to the real claude-mem or publish to npm
        'git with a GitHub login': 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/thedotmack/claude-mem-pro',
        'use a gh login': 'gh auth token',
        'publish to npm': 'npm whoami --registry=https://registry.npmjs.org/',
    }
    if platform.system() != 'Darwin':
        if not bwrap_works() and os.environ.get('EMV_THROWAWAY_BOX') != '1' and os.environ.get('EMV_ALLOW_NO_SANDBOX') != '1':
            sys.exit('bubblewrap (bwrap) is not working here. Install it (apt install bubblewrap), or set '
                     'EMV_THROWAWAY_BOX=1 on a throwaway machine with no logins of yours on it.')
        must_fail = dict(released, **{
            'send an iMessage': f'command -v osascript || test -e "{real_home}/Library/Messages"',
            'read your Claude login': f'test -s "{real_home}/.claude/.credentials.json"',
        })
        if bwrap_works():
            must_fail.update({'write outside the run dir': f'touch "{real_home}/.emv-imessage-build-probe"',
                              'read your git credentials': f'test -s "{real_home}/.git-credentials"'})
        must_work = {'write the run dir': f'touch "{arm_dir}/.probe" && rm "{arm_dir}/.probe"',
                     'write /tmp': 'touch /tmp/.probe && rm /tmp/.probe', 'node': 'node -e 1',
                     'bun': 'bun --version', 'git': 'git --version', 'claude': 'claude --version',
                     'reach GitHub': 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/thedotmack/claude-mem HEAD',
                     'reach OpenRouter': 'curl -sSf -o /dev/null https://openrouter.ai/api/v1/models'}
        if os.environ.get('EMV_OPENROUTER_BASE'):  # tests: a stand-in for OpenRouter, so nothing to reach
            must_work.pop('reach OpenRouter')
        bad = []
        for name, cmd in must_fail.items():
            if subprocess.run(sandbox_cmd(arm_dir) + ['/bin/bash', '-c', cmd], env=no_token, capture_output=True).returncode == 0:
                bad.append(f'could {name}')
        for name, cmd in must_work.items():
            if subprocess.run(sandbox_cmd(arm_dir) + ['/bin/bash', '-c', cmd], env=env, capture_output=True).returncode != 0:
                bad.append(f'could not {name}')
        Path(real_home, '.emv-imessage-build-probe').unlink(missing_ok=True)
        if bad:
            sys.exit(f'{arm_dir.name}: sandbox check failed ({"; ".join(bad)}). Nothing was run.')
        log(f'{arm_dir.name}: sandbox check passed ({"bubblewrap" if bwrap_works() else "throwaway box, no bubblewrap"})')
        return
    must_fail = {
        'read Messages': f'ls "{real_home}/Library/Messages"',
        'run osascript': 'osascript -e "return 1"',
        'run launchctl': '/bin/launchctl list',
        'write in your home': f'touch "{real_home}/.emv-imessage-build-probe"',
        'read your Claude login': f'ls "{real_home}/.claude"',
        'git with your keychain': 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/thedotmack/claude-mem-pro',
        'read the keychain': 'security find-generic-password -s "Claude Code-credentials" -w',
        'use a gh login': released['use a gh login'],
        'publish to npm': released['publish to npm'],
    }
    must_work = {'write the run dir': f'touch "{arm_dir}/.probe" && rm "{arm_dir}/.probe"', 'node': 'node -e 1',
                 'bun': 'bun --version', 'git': 'git --version', 'claude': 'claude --version',
                 'reach GitHub': 'GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/thedotmack/claude-mem HEAD',
                 'reach OpenRouter': 'curl -sSf -o /dev/null https://openrouter.ai/api/v1/models'}
    bad = []
    for name, cmd in must_fail.items():
        if subprocess.run(sandbox_cmd(arm_dir) + ['/bin/bash', '-c', cmd], env=no_token, capture_output=True).returncode == 0:
            bad.append(f'could {name}')
    for name, cmd in must_work.items():
        if subprocess.run(sandbox_cmd(arm_dir) + ['/bin/bash', '-c', cmd], env=env, capture_output=True).returncode != 0:
            bad.append(f'could not {name}')
    Path(real_home, '.emv-imessage-build-probe').unlink(missing_ok=True)
    if bad:
        sys.exit(f'{arm_dir.name}: sandbox check failed ({"; ".join(bad)}). Nothing was run.')
    log(f'{arm_dir.name}: sandbox check passed')


# ---------------------------------------------------------------------------------------------------- repos

def make_seed(out, base_ref, prompts):
    """A bare repo holding the base commit plus the spec, the starting point of every arm."""
    seed = out / 'seed.git'
    base = sh(['git', '-C', str(REPO), 'rev-parse', base_ref]).stdout.strip()
    sh(['git', 'init', '--bare', '-q', str(seed)])
    work = out / 'seed-work'
    git_env = clean_git_env(out / 'seed-home')
    pushed = sh(['git', '-C', str(REPO), 'push', '-q', '--no-verify', str(seed), f'{base}:refs/heads/feat/wire-gateway'],
                check=False)
    if pushed.returncode == 0:
        sh(['git', 'clone', '-q', str(seed), str(work)])
    else:
        # A shallow checkout can't push its history: start from a one-commit snapshot of the base instead.
        log(f'seed: no history to copy ({pushed.stderr.strip().splitlines()[-1] if pushed.stderr.strip() else "push failed"});'
            ' using a snapshot of the base commit')
        work.mkdir()
        sh(['git', 'init', '-q', '-b', 'feat/wire-gateway', str(work)], env=git_env)
        archive = subprocess.run(['git', '-C', str(REPO), 'archive', base], capture_output=True, check=True)
        subprocess.run(['tar', '-x', '-C', str(work)], input=archive.stdout, check=True)
        sh(['git', '-C', str(work), 'add', '-A'], env=git_env)
        sh(['git', '-C', str(work), 'commit', '-q', '-m', f'snapshot of {base}'], env=git_env)
        sh(['git', '-C', str(work), 'remote', 'add', 'origin', str(seed)], env=git_env)
    dest = work / prompts['spec_path']
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(HERE / 'spec.md', dest)
    sh(['git', '-C', str(work), 'add', prompts['spec_path']], env=git_env)
    sh(['git', '-C', str(work), 'commit', '-q', '-m', 'docs: add the Photon iMessage agent spec (test seed)'], env=git_env)
    sh(['git', '-C', str(work), 'push', '-q', 'origin', 'feat/wire-gateway'], env=git_env)
    shutil.rmtree(work)
    return base


def clean_git_env(home, name='imessage-build harness'):
    """Git with no system or global config (so no keychain credential helper) and a throwaway identity."""
    home.mkdir(parents=True, exist_ok=True)
    (home / '.gitconfig').write_text(f'[user]\n\tname = {name}\n\temail = imessage-build@localhost\n'
                                     '[credential]\n\thelper =\n[init]\n\tdefaultBranch = main\n')
    env = dict(os.environ, HOME=str(home), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(home / '.gitconfig'),
               GIT_TERMINAL_PROMPT='0')
    return env


def make_arm_repo(arm_dir, seed):
    sh(['git', 'clone', '-q', '--bare', str(seed), str(arm_dir / 'origin.git')])
    sh(['git', 'clone', '-q', '-b', 'feat/wire-gateway', str(arm_dir / 'origin.git'), str(arm_dir / 'repo')])


# ---------------------------------------------------------------------------------------------------- registry

def start_registry(arm_dir, port, procs):
    """A local npm registry for the arm's test packages, with one user whose token goes in the builder's .npmrc."""
    reg = arm_dir / 'registry'
    reg.mkdir(exist_ok=True)
    (reg / 'config.yaml').write_text(f"""storage: {reg}/storage
auth:
  htpasswd:
    file: {reg}/htpasswd
uplinks: {{}}
packages:
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
listen: 127.0.0.1:{port}
log: {{type: file, path: {reg}/verdaccio.log, level: warn}}
""")
    p = subprocess.Popen(['npx', '-y', VERDACCIO, '--config', str(reg / 'config.yaml')], stdout=open(reg / 'stdout.log', 'w'),
                         stderr=subprocess.STDOUT, start_new_session=True)
    procs.append(p)
    url = f'http://127.0.0.1:{port}'
    import urllib.request
    for _ in range(240):
        try:
            urllib.request.urlopen(f'{url}/-/ping', timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    else:
        sys.exit(f'{arm_dir.name}: local registry did not start (see {reg}/stdout.log)')
    body = json.dumps({'name': 'emv', 'password': 'emv-local-only'}).encode()
    req = urllib.request.Request(f'{url}/-/user/org.couchdb.user:emv', data=body, method='PUT',
                                 headers={'content-type': 'application/json'})
    token = json.load(urllib.request.urlopen(req, timeout=10))['token']
    host = url.split('//', 1)[1]
    (arm_dir / 'home').mkdir(exist_ok=True)
    (arm_dir / 'home' / '.npmrc').write_text(f'//{host}/:_authToken={token}\n')
    return url


# ---------------------------------------------------------------------------------------------------- stack

def settings_merge(arm_dir, profile, model, permissions):
    env = {}
    if profile == 'openrouter':
        # Every model slot Claude Code may pick (main, background, subagent) on the same model (OpenRouter's guide).
        env = {k: model for k in ('ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                                  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL')}
    merge = {'env': env}
    if permissions == 'bypass':
        # The builder needs the whole toolchain (bun, npm, git, gh, its own servers). The sandbox is what limits it.
        merge['permissions'] = {'defaultMode': 'bypassPermissions', 'allow': [], 'deny': []}
    path = arm_dir / 'settings-merge.json'
    path.write_text(json.dumps(merge, indent=1))
    return path


def start_stack(arm, arm_dir, args):
    env = dict(os.environ, EMV_OBSERVER_MODEL=args.notetaker_model,
               EMV_CLAUDE_SETTINGS_MERGE=str(settings_merge(arm_dir, args.profile, args.model, args.permissions)))
    if args.profile == 'openrouter':
        env['EMV_AGENT_UPSTREAM'] = OPENROUTER_BASE
    if args.notetaker == 'openrouter':  # no Claude login here: the newest Haiku through OpenRouter, still through its tee
        env.update(EMV_OBSERVER_UPSTREAM=OPENROUTER_BASE, EMV_OBSERVER_KEY_ENV='OPENROUTER_API_KEY')
    r = subprocess.run([str(TASKS / 'stack.sh'), 'start', arm, str(arm_dir), str(PORTS[arm])], env=env, text=True,
                       capture_output=True)
    (arm_dir / 'stack-start.log').write_text(r.stdout + r.stderr)
    if r.returncode:
        sys.exit(f'{arm}: stack did not start:\n{r.stdout}{r.stderr}')
    # Same skills for every arm, copied (not linked), so the build editing its own repo's skills changes nothing here.
    for name in SKILLS:
        shutil.copytree(REPO / 'plugin' / 'skills' / name, arm_dir / 'claude-config' / 'skills' / name, dirs_exist_ok=True)
    mcp = {'mcpServers': {}}
    if arm != 'plain':
        mcp['mcpServers']['claude-mem'] = {'command': 'node', 'args': [str(REPO / 'plugin' / 'scripts' / 'mcp-server.cjs')],
                                           'env': {'CLAUDE_MEM_DATA_DIR': str(arm_dir / 'data'), 'HOME': str(arm_dir / 'home')}}
    (arm_dir / 'mcp.json').write_text(json.dumps(mcp, indent=1))


def stop_stack(arm, arm_dir):
    subprocess.run([str(TASKS / 'stack.sh'), 'stop', arm, str(arm_dir)], capture_output=True)


def builder_env(arm_dir, profile, key, registry, gh_repo, gh_token):
    keep = ['PATH', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
            'SSL_CERT_FILE', 'NODE_OPTIONS']
    env = {k: os.environ[k] for k in keep if k in os.environ}
    home = arm_dir / 'home'
    git = clean_git_env(home, name=f'imessage-build {arm_dir.name} builder')
    env.update({k: git[k] for k in ('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT')})
    env.update(HOME=str(home), CLAUDE_CONFIG_DIR=str(arm_dir / 'claude-config'), DO_NOT_TRACK='1',
               XDG_CONFIG_HOME=str(home / '.config'), TEST_NPM_REGISTRY=registry,
               npm_config_userconfig=str(home / '.npmrc'), DISABLE_AUTOUPDATER='1')
    if gh_repo:
        env['TEST_GH_REPO'] = gh_repo
    if gh_token:
        env['GH_TOKEN'] = gh_token
    if profile == 'openrouter':
        env.update(ANTHROPIC_AUTH_TOKEN=key, ANTHROPIC_API_KEY='')
    elif os.environ.get('ANTHROPIC_API_KEY'):
        env['ANTHROPIC_API_KEY'] = os.environ['ANTHROPIC_API_KEY']
    else:
        token = sh(['bun', '-e', f"import {{ readClaudeAccessToken }} from '{HERE.parent}/forward/tee-proxy.ts';"
                    " process.stdout.write(readClaudeAccessToken() ?? '')"], check=False).stdout.strip()
        if token:
            env['CLAUDE_CODE_OAUTH_TOKEN'] = token
    return env


# ---------------------------------------------------------------------------------------------------- sessions

def git_head(repo):
    return sh(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=False).stdout.strip()


def run_session(arm, arm_dir, n, prompt, args, env, stop_after):
    """One fresh Claude Code session. Returns its row for the sessions table."""
    repo = arm_dir / 'repo'
    logs = arm_dir / 'logs' / 'sessions'
    logs.mkdir(parents=True, exist_ok=True)
    cmd = sandbox_cmd(arm_dir) + [args.claude, '-p', prompt, '--model', args.model, '--output-format', 'stream-json',
                                  '--verbose', '--mcp-config', str(arm_dir / 'mcp.json'), '--strict-mcp-config']
    head_before = git_head(repo)
    started = time.time()
    tool_calls, stopped, result = 0, '', {}
    with open(logs / f'{n}.jsonl', 'w') as out, open(logs / f'{n}.err', 'w') as err:
        p = subprocess.Popen(cmd, cwd=repo, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err,
                             text=True, start_new_session=True)

        def on_timeout():
            nonlocal stopped
            if not stopped:
                stopped = 'timeout'
                os.killpg(p.pid, signal.SIGTERM)
        watchdog = threading.Timer(args.session_timeout, on_timeout)
        watchdog.start()
        for line in p.stdout:
            out.write(line)
            out.flush()
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get('type') == 'assistant':
                tool_calls += sum(1 for b in event.get('message', {}).get('content', []) if b.get('type') == 'tool_use')
            elif event.get('type') == 'result':
                result = event
            if stop_after and tool_calls >= stop_after and not stopped:
                stopped = 'stop_mid_session'
                os.killpg(p.pid, signal.SIGTERM)
        watchdog.cancel()
        try:
            code = p.wait(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            code = p.wait()
    ended = time.time()
    head_after = git_head(repo)
    commits = int(sh(['git', '-C', str(repo), 'rev-list', '--count', f'{head_before}..{head_after}'], check=False).stdout.strip() or 0) \
        if head_before and head_after else 0
    test_json = repo / 'imessage-agent.test.json'
    session_id = result.get('session_id') or next(
        (json.loads(l).get('session_id') for l in open(logs / f'{n}.jsonl') if '"session_id"' in l), None)
    return dict(session_no=n, prompt=prompt, started_at=datetime.fromtimestamp(started, timezone.utc).isoformat(timespec='seconds'),
                ended_at=datetime.fromtimestamp(ended, timezone.utc).isoformat(timespec='seconds'), started_epoch=started,
                ended_epoch=ended, elapsed_s=round(ended - started, 1), exit_code=code, stopped=stopped,
                tool_calls=tool_calls, cc_num_turns=result.get('num_turns'), cc_cost_usd=result.get('total_cost_usd'),
                session_id=session_id, result_text=(result.get('result') or '')[:4000], head_before=head_before,
                head_after=head_after, commits=commits,
                test_json=test_json.read_text()[:4000] if test_json.exists() else None)


def build_complete(row):
    try:
        return bool(json.loads(row['test_json'] or '{}').get('complete'))
    except json.JSONDecodeError:
        return False


def run_arm(arm, arm_dir, run_id, args, prompts, env, db_path):
    db = open_db(db_path)
    db.executescript(SESSIONS_SCHEMA)
    version = sh([args.claude, '--version'], check=False).stdout.strip()
    db.execute('INSERT OR REPLACE INTO runs (run_id, arm, model, started_at, arm_dir, claude_version, notes, sessions) '
               'VALUES (?,?,?,?,?,?,?,?)', (run_id, arm, args.model, now(), str(arm_dir), version,
                                            'imessage-build: Photon iMessage agent spec', prompts['sessions_planned']))
    db.commit()
    stop = prompts['stop_mid_session']
    planned = prompts['sessions_planned']
    n = 0
    while True:
        n += 1
        if n > planned + args.extra_sessions:
            break
        prompt = prompts['sessions'].get(str(n), prompts['base_prompt'])
        stop_after = args.stop_after_tools if n == stop['session'] else 0
        log(f'{arm}: session {n} start' + (f' (stopped after {stop_after} tool calls)' if stop_after else ''))
        row = run_session(arm, arm_dir, n, prompt, args, env, stop_after)
        log(f'{arm}: session {n} done in {row["elapsed_s"]:.0f}s, {row["tool_calls"]} tool calls, {row["commits"]} commits'
            + (f', stopped: {row["stopped"]}' if row['stopped'] else ''))
        cols = ', '.join(row)
        db.execute(f'INSERT OR REPLACE INTO sessions (run_id, arm, {cols}) VALUES (?,?,{",".join("?" * len(row))})',
                   (run_id, arm, *row.values()))
        db.execute('INSERT OR REPLACE INTO turns (run_id, arm, turn_no, kind, started_at, ended_at, started_epoch, '
                   'ended_epoch, elapsed_s, claude_exit, cc_num_turns, cc_cost_usd, session_id, result_text, session_no) '
                   'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (run_id, arm, n, 'session', row['started_at'], row['ended_at'], row['started_epoch'],
                    row['ended_epoch'], row['elapsed_s'], row['exit_code'], row['cc_num_turns'], row['cc_cost_usd'],
                    row['session_id'], row['result_text'], n))
        db.commit()
        if arm != 'plain':
            # The next session must find this one's notes: wait until the note-taker has written them all.
            subprocess.run([sys.executable, str(TASKS / 'wait_observer.py'), str(arm_dir), '--max', '1200'])
        if n >= planned and build_complete(row):
            break
    db.execute('UPDATE runs SET ended_at=? WHERE run_id=?', (now(), run_id))
    db.commit()


# ---------------------------------------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--out', required=True, type=Path, help='a new output dir (never reused)')
    p.add_argument('--arms', default='plain,claudemem,endless')
    p.add_argument('--profile', choices=['openrouter', 'anthropic'], default='openrouter',
                   help='openrouter: the agent on OpenRouter (DeepSeek); anthropic: a Claude stand-in, for smoke tests')
    p.add_argument('--model', default='~deepseek/deepseek-flash-latest')
    p.add_argument('--base-ref', default='origin/feat/wire-gateway')
    p.add_argument('--session-timeout', type=int, default=3 * 3600, help='seconds before a session is stopped')
    p.add_argument('--extra-sessions', type=int, default=2,
                   help='more "continue" sessions after the planned six, until the build says it is complete')
    p.add_argument('--stop-after-tools', type=int, default=0, help='override prompts.json\'s session-3 stop')
    p.add_argument('--sessions', type=int, default=0, help='run only this many sessions (smoke tests)')
    p.add_argument('--permissions', choices=['bypass', 'narrow'], default='bypass',
                   help="narrow: the task benchmark's small allowlist instead (smoke tests where bypass isn't allowed)")
    p.add_argument('--notetaker', choices=['claude', 'openrouter'], default='claude',
                   help="claude-mem's note-taker: claude (your Claude login) or openrouter (no Claude login, e.g. a Sprite)")
    p.add_argument('--notetaker-model', default='', help="default: 'haiku', or OpenRouter's newest-Haiku alias")
    p.add_argument('--claude', default=shutil.which('claude'))
    args = p.parse_args()
    args.notetaker_model = args.notetaker_model or ('haiku' if args.notetaker == 'claude' else NEWEST_HAIKU_OPENROUTER)
    prompts = json.loads((HERE / 'prompts.json').read_text())
    args.stop_after_tools = args.stop_after_tools or prompts['stop_mid_session']['after_tool_calls']
    if args.sessions:
        prompts['sessions_planned'] = args.sessions
        args.extra_sessions = 0
    arms = args.arms.split(',')
    for tool in ('git', 'bun', 'jq', 'node', 'npx', 'python3'):
        if not shutil.which(tool):
            sys.exit(f'{tool} is not installed')
    if not args.claude:
        sys.exit('Claude Code (claude) is not installed')
    key = ''
    if args.profile == 'openrouter':
        key = os.environ.get('OPENROUTER_API_KEY', '')
        if not key.startswith('sk-or-'):
            sys.exit('set OPENROUTER_API_KEY to an OpenRouter key (sk-or-...)')
    if args.notetaker == 'openrouter' and not key:
        key = os.environ.get('OPENROUTER_API_KEY', '')
        if not key.startswith('sk-or-'):
            sys.exit('--notetaker openrouter needs OPENROUTER_API_KEY (sk-or-...)')
    if args.profile == 'openrouter':
        check_openrouter_model(args.model, key, 'the agent')
    if args.notetaker == 'openrouter':
        check_openrouter_model(args.notetaker_model, key, 'the note-taker')
    if args.out.exists():
        sys.exit(f'{args.out} exists; use a new output dir')
    args.out.mkdir(parents=True)
    out = args.out.resolve()
    real_home = Path(os.environ['HOME']).resolve()
    gh_prefix, gh_token = os.environ.get('TEST_GH_REPO_PREFIX', ''), os.environ.get('TEST_GH_TOKEN', '')
    if gh_prefix and not gh_token:
        sys.exit('TEST_GH_REPO_PREFIX is set but TEST_GH_TOKEN is not (a fine-grained token for those repos only)')

    base = make_seed(out, args.base_ref, prompts)
    log(f'seed: {args.base_ref} = {base[:10]} + the spec')
    procs, started = [], []

    def cleanup(*_):
        for p_ in procs:
            try:
                os.killpg(p_.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for arm_, dir_ in started:
            stop_stack(arm_, dir_)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        envs = {}
        for arm in arms:
            arm_dir = out / arm
            arm_dir.mkdir()
            (arm_dir / 'sandbox.sb').write_text(sandbox_profile(arm_dir, real_home))
            make_arm_repo(arm_dir, out / 'seed.git')
            registry = start_registry(arm_dir, PORTS[arm] + 5, procs)
            started.append((arm, arm_dir))
            start_stack(arm, arm_dir, args)
            env = builder_env(arm_dir, args.profile, key, registry, f'{gh_prefix}-{arm}' if gh_prefix else '', gh_token)
            preflight_sandbox(arm_dir, env, real_home)
            envs[arm] = env
        # Arms side by side: one process per arm, each running its sessions in order.
        children = {}
        for arm in arms:
            pid = os.fork()
            if pid == 0:
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                try:
                    with open(out / f'{arm}.log', 'a') as f:
                        os.dup2(f.fileno(), 1)
                        os.dup2(f.fileno(), 2)
                        run_arm(arm, out / arm, f'imsg-{arm}', args, prompts, envs[arm], out / 'results.sqlite')
                    os._exit(0)
                except BaseException as e:  # noqa: BLE001  (report and exit the child, whatever happened)
                    print(f'{arm} failed: {e!r}', file=sys.stderr)
                    os._exit(1)
            children[pid] = arm
            log(f'{arm}: building (log: {out / f"{arm}.log"})')
        failed = []
        for _ in children:
            pid, status = os.wait()
            if status:
                failed.append(children[pid])
        for arm in arms:
            subprocess.run([sys.executable, str(TASKS / 'extract.py'), '--db', str(out / 'results.sqlite'),
                            '--run-id', f'imsg-{arm}', '--arm-dir', str(out / arm), '--openrouter-prices', str(out / 'prices')])
        log('all arms done' + (f'; failed: {", ".join(failed)}' if failed else ''))
    finally:
        cleanup()


if __name__ == '__main__':
    main()
