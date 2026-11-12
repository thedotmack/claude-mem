"""Actual Cline CLI and MCP, with a deterministic local provider and isolated data."""
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
root = pathlib.Path(tempfile.mkdtemp(prefix='cmem-cline-')).resolve()
bun = os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun'
cline = os.environ.get('CLINE_BIN') or shutil.which('cline') or 'cline'
for name in ['home', 'worker', 'project', 'data/settings']:
    (root / name).mkdir(parents=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
settings = root / 'data/settings/cline_mcp_settings.json'
env = {'HOME': str(root / 'home'), 'PATH': os.path.dirname(bun) + ':' + os.environ['PATH'],
       'DO_NOT_TRACK': '1', 'CLINE_TELEMETRY_DISABLED': '1', 'CLAUDE_MEM_DATA_DIR': str(root / 'worker'),
       'CLAUDE_MEM_WORKER_PORT': str(port), 'CLINE_MCP_SETTINGS_PATH': str(settings)}
(root / 'worker/settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT': str(port),
    'CLAUDE_MEM_OBSERVER_ENABLED': 'false', 'CLAUDE_MEM_CHROMA_ENABLED': 'false',
    'CLAUDE_MEM_AUTO_UPDATE': 'false', 'CLAUDE_MEM_WORK_VIEW_AGENT': 'off'}))
base = [cline, '--data-dir', str(root / 'data'), '--config', str(root / 'config'), '--cwd', str(root / 'project')]
actions, received = [], []

class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        received.append(body)
        n = sum(m.get('role') == 'tool' for m in body.get('messages', []))
        if n >= len(actions):
            chunks = [({'role': 'assistant', 'content': 'Fixture complete.'}, None), ({}, 'stop')]
        else:
            name, args = actions[n]
            call = {'index': 0, 'id': f'memory-{n}', 'type': 'function',
                    'function': {'name': 'claude-mem__' + name, 'arguments': json.dumps(args)}}
            chunks = [({'role': 'assistant', 'tool_calls': [call]}, None), ({}, 'tool_calls')]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for delta, finish in chunks:
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture-model',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()

provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()

def cli(args, label):
    result = subprocess.run(base + args, env=env, cwd=root / 'project', capture_output=True, text=True, timeout=65)
    (root / f'{label}.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, (label, result.stdout, result.stderr)
    return result

def worker(command):
    subprocess.run([bun, repo / 'plugin/scripts/worker-service.cjs', command], env=env, cwd=repo, check=True, timeout=45)

def http(path, body=None):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response: return json.load(response)

def run(tool_actions, label):
    actions[:] = tool_actions; received.clear()
    cli(['--provider', 'openai-compatible', '--model', 'fixture-model', '--json', '--timeout', '45', '--retries', '1',
         'Execute only the requested fixture memory calls.'], label)
    assert received, 'No local provider request'
    (root / f'{label}-requests.json').write_text(json.dumps(received, indent=2))
    results = [json.loads(m['content']) for m in received[-1]['messages'] if m.get('role') == 'tool']
    assert len(results) == len(actions), results
    return results

try:
    worker('start')
    deadline = time.monotonic() + 40
    while True:
        try: http('/api/readiness'); break
        except Exception:
            if time.monotonic() > deadline: raise
            time.sleep(.1)
    foreign = http('/api/memory/save', {'project': 'foreign', 'text': 'FOREIGN restore fixture never disclose'})['id']
    sentinel = {'transport': {'type': 'stdio', 'command': 'unused-fixture'}, 'disabled': True}
    settings.write_text(json.dumps({'mcpServers': {'unrelated': sentinel}}))
    install = ['mcp', 'add', 'claude-mem', '--yes', '--', '/usr/bin/env',
               f'CLAUDE_MEM_WORKER_URL={url}', bun, str(repo / 'plugin/scripts/mcp-server.cjs')]
    cli(install, 'install'); first = json.loads(settings.read_text())
    cli(install, 'repeat-install'); assert json.loads(settings.read_text()) == first
    assert first['mcpServers']['unrelated'] == sentinel
    cli(['auth', '-p', 'openai-compatible', '-k', 'local-fixture-only', '-m', 'fixture-model',
         '-b', f'http://127.0.0.1:{provider.server_port}/v1', '--data-dir', str(root / 'data'), '--config', str(root / 'config')], 'configure-local-provider')
    configured = json.loads((root / 'data/settings/providers.json').read_text())['providers']['openai-compatible']['settings']
    assert configured['baseUrl'] == f'http://127.0.0.1:{provider.server_port}/v1' and configured['apiKey'] == 'local-fixture-only'
    text = 'Cline explicitly saved this restore decision.'
    saved = run([('save_memory', {'text': text, 'project': 'cline-fixture'})], 'save')
    assert not saved[0].get('isError') and 'Saved memory #' in json.dumps(saved[0]), saved
    rows = http('/api/search?query=restore&project=cline-fixture&type=observations&format=json')['observations']
    note = next(row for row in rows if row['narrative'] == text)
    results = run([('search', {'query': 'restore', 'project': 'cline-fixture'}),
                   ('get_observations', {'ids': [note['id'], foreign], 'project': 'cline-fixture'})], 'recall')
    assert all(not result.get('isError') for result in results), results
    search_text = '\n'.join(part.get('text', '') for part in results[0].get('content', []) if part.get('type') == 'text')
    assert any(re.search(rf'\|\s*#{note["id"]}\s*\|', line) and text in line for line in search_text.splitlines()), search_text
    assert text in json.dumps(results[1]) and 'FOREIGN' not in json.dumps(results), results
    worker('stop')
    failed = run([('get_observations', {'ids': [note['id']], 'project': 'cline-fixture'})], 'stopped-worker')
    assert failed[0].get('isError') is True, failed
    cli(['mcp', 'remove', 'claude-mem'], 'remove')
    assert json.loads(settings.read_text())['mcpServers'] == {'unrelated': sentinel}
    print('PASS: actual Cline save, scoped recall, foreign ID withheld, stopped-worker error, repeat setup and clean removal')
finally:
    worker('stop'); provider.shutdown(); provider.server_close()
    print('Evidence:', root)
