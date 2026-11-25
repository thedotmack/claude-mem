"""The MCP entry documented in docs/public/kiro.mdx, run over stdio the way Kiro runs it."""
import json
import os
import pathlib
import re
import select
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='cmem kiro ')).resolve()
bun = os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun'
node = os.environ.get('NODE_BIN') or shutil.which('node') or 'node'
for name in ['home', 'worker', 'project']:
    (root / name).mkdir()
(root / 'claude mem').symlink_to(repo)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
env = {'PATH': os.environ['PATH'], 'BUN': bun, 'HOME': str(root / 'home'), 'CLAUDE_MEM_DATA_DIR': str(root / 'worker'),
       'CLAUDE_MEM_WORKER_PORT': str(port)}
(root / 'worker/settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT': str(port),
    'CLAUDE_MEM_OBSERVER_ENABLED': 'false', 'CLAUDE_MEM_CHROMA_ENABLED': 'false',
    'CLAUDE_MEM_AUTO_UPDATE': 'false', 'CLAUDE_MEM_WORK_VIEW_AGENT': 'off'}))

blocks = re.findall(r'```json\n(.*?)```', (repo / 'docs/public/kiro.mdx').read_text(), re.S)
assert len(blocks) == 1, f'kiro.mdx must hold exactly one json block, found {len(blocks)}'
servers = json.loads(blocks[0])['mcpServers']
assert list(servers) == ['claude-mem'], servers
entry = json.loads(blocks[0].replace('/absolute/path/to/node', node)
                   .replace('/absolute/path/to/claude-mem', str(root / 'claude mem')))['mcpServers']['claude-mem']
assert '/absolute/path/to' not in json.dumps(entry), entry
command = [entry['command'], *entry['args']]
servers_started = []

def worker(action):
    subprocess.run([bun, repo / 'plugin/scripts/worker-service.cjs', action], env=env, cwd=repo, check=True, timeout=45)

def worker_stopped():
    worker('stop')
    deadline = time.monotonic() + 15
    while True:
        try: http('/api/readiness')
        except Exception: return
        assert time.monotonic() < deadline, 'worker still answers after stop'
        time.sleep(.2)

def http(path, body=None):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)

class Server:
    def __init__(self, extra_env=None):
        self.proc = subprocess.Popen(command, env={**env, **entry.get('env', {}), **(extra_env or {})},
                                     cwd=root / 'project', stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL)
        servers_started.append(self.proc); self.n = 0; self.buffer = b''
        self.call('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                 'clientInfo': {'name': 'kiro-fixture', 'version': '0'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + '\n').encode()); self.proc.stdin.flush()

    def call(self, method, params, timeout=40):
        self.n += 1; wanted = self.n
        self.send({'jsonrpc': '2.0', 'id': wanted, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while True:
            while b'\n' not in self.buffer:
                assert select.select([self.proc.stdout], [], [], max(0, deadline - time.monotonic()))[0], f'{method} timed out'
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                assert chunk, f'{method}: server closed'
                self.buffer += chunk
            line, self.buffer = self.buffer.split(b'\n', 1)
            message = json.loads(line)
            if message.get('id') == wanted: return message

    def tool(self, name, args, timeout=40):
        result = self.call('tools/call', {'name': name, 'arguments': args}, timeout)['result']
        return bool(result.get('isError')), '\n'.join(p.get('text', '') for p in result['content'] if p.get('type') == 'text')

    def close(self):
        self.proc.kill(); self.proc.wait()

try:
    worker('start')
    deadline = time.monotonic() + 40
    while True:
        try: http('/api/readiness'); break
        except Exception:
            if time.monotonic() > deadline: raise
            time.sleep(.1)
    foreign = http('/api/memory/save', {'project': 'foreign', 'text': 'FOREIGN restore fixture never disclose'})['id']
    server = Server()
    names = {tool['name'] for tool in server.call('tools/list', {})['result']['tools']}
    assert {'save_memory', 'search', 'get_observations'} <= names, names
    text = 'Kiro explicitly saved this restore decision.'
    failed, saved = server.tool('save_memory', {'text': text, 'project': 'kiro-fixture'})
    assert not failed, saved
    note = int(re.search(r'Saved memory #(\d+)', saved).group(1))
    failed, found = server.tool('search', {'query': 'restore', 'project': 'kiro-fixture'})
    assert not failed, found
    assert any(re.search(rf'\|\s*#{note}\s*\|', line) and text in line for line in found.splitlines()), found
    assert 'FOREIGN' not in found, found
    failed, details = server.tool('get_observations', {'ids': [note, foreign], 'project': 'kiro-fixture'})
    assert not failed and text in details and 'FOREIGN' not in details, details
    server.close()

    worker_stopped()
    server = Server()
    failed, details = server.tool('get_observations', {'ids': [note], 'project': 'kiro-fixture'})
    assert not failed and text in details, details
    server.close()

    for extra in [{'CLAUDE_MEM_WORKER_AUTOSTART': 'false'}, {'CLAUDE_MEM_WORKER_URL': url}]:
        worker_stopped()
        server = Server(extra)
        failed, details = server.tool('get_observations', {'ids': [note], 'project': 'kiro-fixture'}, timeout=30)
        assert failed and 'checking the worker connection' in details, details
        server.close()
    print('PASS: documented Kiro entry saves, searches and fetches scoped records, withholds a foreign ID, starts a stopped worker and reports a worker connection error when auto-start is off by setting or by CLAUDE_MEM_WORKER_URL')
finally:
    for proc in servers_started: proc.kill()
    worker('stop')
    print('Evidence:', root)
