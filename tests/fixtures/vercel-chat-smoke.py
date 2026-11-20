"""Real Chat SDK Web transport + isolated worker. No model or platform account."""
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
bun = os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun'
root = pathlib.Path(tempfile.mkdtemp(prefix='cmem-chat-')).resolve()
home, data = root / 'home', root / 'data'
home.mkdir(); data.mkdir()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

worker_port, chat_port = free_port(), free_port()
worker_url = f'http://127.0.0.1:{worker_port}'
chat_url = f'http://127.0.0.1:{chat_port}/chat'
token = secrets.token_urlsafe(32)
project = 'chat-fixture'
(data / 'settings.json').write_text(json.dumps({
    'CLAUDE_MEM_WORKER_PORT': str(worker_port), 'CLAUDE_MEM_OBSERVER_ENABLED': 'false',
    'CLAUDE_MEM_CHROMA_ENABLED': 'false', 'CLAUDE_MEM_AUTO_UPDATE': 'false', 'CLAUDE_MEM_WORK_VIEW_AGENT': 'off',
}))
env = {'PATH': os.path.dirname(bun) + ':' + os.environ['PATH'], 'HOME': str(home),
       'CLAUDE_CONFIG_DIR': str(home / '.claude'), 'CLAUDE_MEM_DATA_DIR': str(data),
       'CLAUDE_MEM_WORKER_PORT': str(worker_port), 'DO_NOT_TRACK': '1',
       'CHAT_MEMORY_PROJECT': project, 'CHAT_DEMO_TOKEN': token,
       'CHAT_DEMO_PORT': str(chat_port)}
worker = repo / 'plugin/scripts/worker-service.cjs'
chat = None

def request(url, body=None, headers=None):
    headers = {'Content-Type': 'application/json', **(headers or {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with urllib.request.urlopen(req, timeout=12) as response:
        return response.read().decode()

def message(text, mid, conversation='first'):
    wire = request(chat_url, {'id': conversation, 'messages': [
        {'id': mid, 'role': 'user', 'parts': [{'type': 'text', 'text': text}]},
    ]}, {'Authorization': f'Bearer {token}'})
    (root / f'{mid}-{conversation}.sse').write_text(wire)
    chunks = []
    for line in wire.splitlines():
        if line.startswith('data: ') and line != 'data: [DONE]':
            part = json.loads(line[6:])
            if part.get('type') == 'text-delta':
                chunks.append(part['delta'])
    return json.loads(''.join(chunks))

def wait_ready(url):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            request(url)
            return
        except urllib.error.HTTPError:
            if url == chat_url: return  # only POST is supported; GET returning 404 proves it listens
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(.1)
    raise AssertionError(f'Service did not become ready: {url}')

try:
    subprocess.run([bun, '--no-install', worker, 'start'], env=env, cwd=repo, check=True, timeout=45)
    wait_ready(worker_url + '/api/readiness')
    foreign = json.loads(request(worker_url + '/api/memory/save', {
        'project': 'other-project', 'text': 'Foreign restore snapshots private fixture',
    }))['id']
    with (root / 'chat.log').open('w') as log:
        chat = subprocess.Popen([bun, repo / 'examples/vercel-chat/memory.mjs'], env={**env, 'CLAUDE_MEM_WORKER_URL': worker_url}, cwd=repo, stdout=log, stderr=log)
    wait_ready(chat_url)
    try:
        request(chat_url, {'id': 'unauth', 'messages': []})
        raise AssertionError('Unauthenticated request accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 401, error.code
    text = 'A restore must reject snapshots missing required worker tables.\nPreserve  exact spacing.'
    saved = message('save ' + text, 'save-1')
    assert saved['success'] is True and saved['project'] == project, saved
    repeated = message('save ' + text, 'save-1')
    assert repeated['id'] == saved['id'] and repeated['duplicate'] is True, repeated
    chat.terminate(); chat.wait(timeout=10)
    with (root / 'chat.log').open('a') as log:
        chat = subprocess.Popen([bun, repo / 'examples/vercel-chat/memory.mjs'],
                                env={**env, 'CLAUDE_MEM_WORKER_URL': worker_url}, cwd=repo, stdout=log, stderr=log)
    wait_ready(chat_url)
    after_restart = message('save ' + text, 'save-1')
    assert after_restart['id'] == saved['id'] and after_restart['duplicate'] is True, after_restart
    search = message('search restore snapshots', 'search-1', 'later-session')
    assert [(row['id'], row['project'], row['narrative']) for row in search['observations']] == [(saved['id'], project, text)], search
    assert 'Foreign restore snapshots' not in json.dumps(search), search
    details = message('get ' + str(saved['id']), 'get-1', 'later-session')
    assert len(details) == 1 and details[0]['id'] == saved['id'] and details[0]['narrative'] == text, details
    assert message('get ' + str(foreign), 'foreign-1') == [], 'Foreign project ID leaked'
    assert 'help' in message('project other-project', 'unknown-1'), 'Client selected a project'
    assert token not in (root / 'chat.log').read_text(), 'Token leaked into logs'
    settings = json.loads((data / 'settings.json').read_text())
    (data / 'settings.json').write_text(json.dumps({**settings, 'CLAUDE_MEM_EXCLUDED_PROJECTS': str(repo)}))
    excluded = message('save excluded fixture must not persist', 'excluded-1')
    assert 'error' in excluded and 'success' not in excluded, excluded
    (data / 'settings.json').write_text(json.dumps(settings))
    assert message('search excluded fixture', 'excluded-search')['observations'] == [], 'Excluded note persisted'
    subprocess.run([bun, '--no-install', worker, 'stop'], env=env, cwd=repo, check=True, timeout=20)
    failed = message('save must not report success', 'stopped-1')
    assert 'error' in failed and 'success' not in failed, failed
    print('PASS: actual Chat SDK save, duplicate receipt, later-thread recall, foreign-project exclusion, authentication, excluded-project skip and stopped-worker failure')
finally:
    if chat:
        chat.terminate()
        try: chat.wait(timeout=10)
        except subprocess.TimeoutExpired: chat.kill(); chat.wait()
    subprocess.run([bun, '--no-install', worker, 'stop'], env=env, cwd=repo, timeout=20)
    print('Evidence:', root)
