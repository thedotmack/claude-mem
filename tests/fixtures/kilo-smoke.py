"""Actual Kilo CLI, local provider and packaged MCP. Synthetic records only."""
import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
root = pathlib.Path(tempfile.mkdtemp(prefix='cmem-kilo-')).resolve()
bun = os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun'
kilo = os.environ.get('KILO_BIN') or shutil.which('kilo') or 'kilo'
for directory in ['home', 'project', 'worker']:
    (root / directory).mkdir()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
env = {'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'home/config'),
       'XDG_DATA_HOME': str(root / 'home/data'), 'XDG_CACHE_HOME': str(root / 'home/cache'),
       'PATH': os.path.dirname(bun) + ':' + os.environ['PATH'], 'DO_NOT_TRACK': '1'}
worker_env = {**env, 'CLAUDE_MEM_DATA_DIR': str(root / 'worker'), 'CLAUDE_MEM_WORKER_PORT': str(port)}
(root / 'worker/settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT': str(port),
    'CLAUDE_MEM_OBSERVER_ENABLED': 'false', 'CLAUDE_MEM_CHROMA_ENABLED': 'false',
    'CLAUDE_MEM_AUTO_UPDATE': 'false', 'CLAUDE_MEM_WORK_VIEW_AGENT': 'off'}))
actions, requests = [], []

class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        n = sum(message.get('role') == 'tool' for message in body.get('messages', []))
        if n >= len(actions):
            chunks = [({'role': 'assistant', 'content': 'Fixture finished.'}, None), ({}, 'stop')]
        else:
            name, arguments = actions[n]
            call = {'index': 0, 'id': f'fixture-{n}', 'type': 'function',
                    'function': {'name': 'claudemem_' + name, 'arguments': json.dumps(arguments)}}
            chunks = [({'role': 'assistant', 'tool_calls': [call]}, None), ({}, 'tool_calls')]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for delta, finish in chunks:
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'test',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')

provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
permissions = {'*': 'deny', **{'claudemem_' + tool: 'allow' for tool in ['save_memory', 'search', 'get_observations']}}
sentinel = {'type': 'local', 'command': ['unused-fixture'], 'enabled': False}
config = {'provider': {'fixture': {'npm': '@ai-sdk/openai-compatible',
    'models': {'test': {'name': 'Fixture', 'limit': {'context': 32000, 'output': 2048}}},
    'options': {'apiKey': 'local-fixture-only', 'baseURL': f'http://127.0.0.1:{provider.server_port}/v1'}}},
    'enabled_providers': ['fixture'], 'model': 'fixture/test', 'permission': permissions,
    'mcp': {'unrelated': sentinel}}
config_path = root / 'project/kilo.json'
entry = {'type': 'local', 'command': [bun, str(repo / 'plugin/scripts/mcp-server.cjs')],
         'environment': {'CLAUDE_MEM_WORKER_URL': url, 'CLAUDE_MEM_DATA_DIR': str(root / 'worker')}}

def write_config(): config_path.write_text(json.dumps(config))
def worker(command):
    subprocess.run([bun, repo / 'plugin/scripts/worker-service.cjs', command], env=worker_env, cwd=repo, check=True, timeout=45)
def http(path, body=None):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)
def run(tool_actions, label):
    actions[:] = tool_actions; requests.clear()
    result = subprocess.run([kilo, 'run', '--pure', '--format', 'json', '--model', 'fixture/test',
                             'Execute the synthetic fixture memory calls only.'],
                            env=env, cwd=root / 'project', capture_output=True, text=True, timeout=120)
    (root / f'{label}.log').write_text(result.stdout + result.stderr)
    (root / f'{label}-requests.json').write_text(json.dumps(requests, indent=2))
    assert result.returncode == 0 and requests, (label, result.returncode, result.stderr)
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    tools = [event['part'] for event in events if event.get('type') == 'tool_use']
    assert len(tools) == len(actions), (label, tools)
    return tools

try:
    worker('start')
    deadline = time.monotonic() + 40
    while True:
        try: http('/api/readiness'); break
        except Exception:
            if time.monotonic() > deadline: raise
            time.sleep(.1)
    foreign = http('/api/memory/save', {'project': 'foreign', 'text': 'FOREIGN restore snapshots fixture'})['id']
    config['mcp']['claudemem'] = entry; write_config()
    first = config_path.read_bytes()
    config['mcp']['claudemem'] = entry; write_config()
    assert config_path.read_bytes() == first
    text = 'Kilo restore snapshots must contain required tables.'
    saved = run([('save_memory', {'text': text, 'project': 'kilo-fixture'})], 'save')[0]
    assert saved['state']['status'] == 'completed' and 'Saved memory #' in saved['state']['output'], saved
    note = next(row for row in http('/api/search?query=restore&project=kilo-fixture&type=observations&format=json')['observations'] if row['narrative'] == text)
    receipt = re.search(r'Saved memory #(\d+)(?!\d)', saved['state']['output'])
    assert receipt and int(receipt[1]) == note['id'], (saved, note)
    recalled = run([('search', {'query': 'restore snapshots', 'project': 'kilo-fixture'}),
                    ('get_observations', {'ids': [note['id'], foreign], 'project': 'kilo-fixture'})], 'recall')
    assert saved['sessionID'] != recalled[0]['sessionID'], 'Recall reused the save session'
    search = recalled[0]['state']['output']
    assert any(re.search(rf'\|\s*#{note["id"]}\s*\|', line) and text in line for line in search.splitlines()), search
    assert text in recalled[1]['state']['output'] and 'FOREIGN' not in json.dumps(recalled), recalled
    config['permission']['claudemem_get_observations'] = 'deny'; write_config()
    denied = run([('get_observations', {'ids': [note['id']], 'project': 'kilo-fixture'})], 'denied')[0]
    assert denied['state']['status'] == 'error' and text not in json.dumps(denied), denied
    config['permission']['claudemem_get_observations'] = 'allow'; write_config()
    worker('stop')
    stopped = run([('get_observations', {'ids': [note['id']], 'project': 'kilo-fixture'})], 'stopped')[0]
    assert stopped['state']['status'] == 'error', stopped
    del config['mcp']['claudemem']; write_config()
    assert json.loads(config_path.read_text())['mcp'] == {'unrelated': sentinel}
    run([], 'disconnected')
    assert not any(tool['function']['name'].startswith('claudemem_') for tool in requests[-1].get('tools', [])), 'Removed tools still exposed'
    print('PASS: real Kilo save, later-session search/details, foreign ID withholding, denied tool, stopped worker and preserved configuration')
finally:
    worker('stop'); provider.shutdown(); provider.server_close()
    print('Evidence:', root)
