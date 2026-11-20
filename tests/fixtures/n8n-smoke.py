import http.server
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
bun = os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun'
node = os.environ.get('NODE_BIN') or shutil.which('node') or 'node'
cli = os.environ.get('N8N_CLI') or shutil.which('n8n')
assert cli, 'Install n8n 2.47.4 and set N8N_CLI to its bin/n8n script.'
assert subprocess.check_output([node, '--version'], text=True).startswith('v24.'), 'Use the tested Node 24 runtime through NODE_BIN.'
root = pathlib.Path(tempfile.mkdtemp(prefix='cmem-n8n-')).resolve()
home, data = root / 'home', root / 'data'
home.mkdir(); data.mkdir()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

port = free_port()
base = f'http://127.0.0.1:{port}'
(data / 'settings.json').write_text(json.dumps({
    'CLAUDE_MEM_WORKER_PORT': str(port), 'CLAUDE_MEM_OBSERVER_ENABLED': 'false',
    'CLAUDE_MEM_CHROMA_ENABLED': 'false', 'CLAUDE_MEM_AUTO_UPDATE': 'false', 'CLAUDE_MEM_WORK_VIEW_AGENT': 'off',
}))
env = {
    'PATH': str(pathlib.Path(node).resolve().parent) + ':' + str(pathlib.Path(bun).resolve().parent) + ':' + os.environ['PATH'],
    'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / '.claude'), 'CLAUDE_MEM_DATA_DIR': str(data),
    'CLAUDE_MEM_WORKER_PORT': str(port), 'DO_NOT_TRACK': '1', 'N8N_USER_FOLDER': str(home),
    'N8N_DIAGNOSTICS_ENABLED': 'false', 'N8N_VERSION_NOTIFICATIONS_ENABLED': 'false',
    'N8N_TEMPLATES_ENABLED': 'false', 'N8N_LICENSE_AUTO_RENEW_ENABLED': 'false',
    'N8N_RUNNERS_BROKER_PORT': str(free_port()),
}
worker = repo / 'plugin/scripts/worker-service.cjs'

def run_workflow(origin, label):
    workflow = json.loads((repo / 'examples/n8n/memory.workflow.json').read_text())
    # Fixed ID only in the isolated test copy. The distributed workflow has no ID.
    workflow['id'] = 'CmemMemoryDemo01'
    config = next(n for n in workflow['nodes'] if n['name'] == 'Configure')
    for item in config['parameters']['assignments']['assignments']:
        if item['name'] == 'baseUrl': item['value'] = origin
        if item['name'] == 'project': item['value'] = 'n8n-fixture'
    file = root / f'{label}.workflow.json'
    file.write_text(json.dumps(workflow))
    imported = subprocess.run([node, cli, 'import:workflow', '--input', str(file)], cwd=root, env=env, capture_output=True, text=True, timeout=90)
    (root / f'{label}.import.log').write_text(imported.stdout + imported.stderr)
    assert imported.returncode == 0, imported.stderr[-1500:]
    result = subprocess.run([node, cli, 'execute', '--id', workflow['id'], '--rawOutput'], cwd=root, env=env, capture_output=True, text=True, timeout=90)
    (root / f'{label}.stdout.log').write_text(result.stdout)
    (root / f'{label}.stderr.log').write_text(result.stderr)
    # The CLI may exit zero after a workflow failure. Inspect its actual run data.
    decoder = json.JSONDecoder()
    for position, character in enumerate(result.stdout):
        if character != '{': continue
        try: execution, _ = decoder.raw_decode(result.stdout[position:])
        except json.JSONDecodeError: continue
        if isinstance(execution, dict) and execution.get('mode') == 'cli' and isinstance(execution.get('data'), dict) and 'resultData' in execution['data']:
            return execution
    raise AssertionError('No n8n execution data returned: ' + result.stderr[-1500:])

requests = []
class RejectSave(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        requests.append(self.path)
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.dumps({'success': False, 'skipped': True, 'reason': 'synthetic refusal'}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        requests.append(self.path); self.send_error(500, 'Recall must not run after an unconfirmed save')

stub = None
try:
    subprocess.run([bun, '--no-install', str(worker), 'start'], cwd=repo, env=env, check=True, timeout=40)
    deadline = time.monotonic() + 30
    while True:
        try:
            with urllib.request.urlopen(base + '/api/readiness', timeout=1) as ready:
                if ready.status == 200: break
        except (urllib.error.URLError, TimeoutError): pass
        if time.monotonic() >= deadline: raise TimeoutError('Worker did not become ready before the fixture deadline')
        time.sleep(0.1)
    req = urllib.request.Request(base + '/api/memory/save', data=json.dumps({'project': 'other', 'text': 'Unrelated restore snapshots fixture', 'title': 'Unrelated fixture'}).encode(), headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=5).close()
    execution = run_workflow(base, 'success')
    result = execution['data']['resultData']
    assert execution['status'] == 'success' and 'error' not in result
    assert result['lastNodeExecuted'] == 'Retrieve'
    runs = result['runData']
    saved = runs['Save'][0]['data']['main'][0][0]['json']
    found = runs['Search'][0]['data']['main'][0][0]['json']['observations']
    retrieved = [item['json'] for item in runs['Retrieve'][0]['data']['main'][0]]
    assert saved['success'] is True
    assert [item['id'] for item in found] == [saved['id']]
    assert [item['id'] for item in retrieved] == [saved['id']]
    assert retrieved[0]['project'] == 'n8n-fixture'
    assert retrieved[0]['narrative'] == 'A restore must reject snapshots missing required worker tables.'
    print('Actual n8n engine saved, searched and retrieved the exact project memory', flush=True)
    stub = http.server.ThreadingHTTPServer(('127.0.0.1', 0), RejectSave)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    rejected = run_workflow(f'http://127.0.0.1:{stub.server_port}', 'unconfirmed')
    assert rejected['data']['resultData'].get('error')
    assert rejected['data']['resultData']['lastNodeExecuted'] == 'Reject unconfirmed save'
    assert requests == ['/api/memory/save'], requests
    print('Unconfirmed save stops before recall and is sent only once', flush=True)
    subprocess.run([bun, '--no-install', str(worker), 'stop'], cwd=repo, env=env, check=True, timeout=20)
    stopped = run_workflow(base, 'stopped')
    assert stopped['data']['resultData'].get('error')
    assert 'Retrieve' not in stopped['data']['resultData']['runData']
    print('Stopped worker produces a failed workflow, not a successful save', flush=True)
    print('Evidence', root)
finally:
    if stub: stub.shutdown(); stub.server_close()
    subprocess.run([bun, '--no-install', str(worker), 'stop'], cwd=repo, env=env, timeout=20)
