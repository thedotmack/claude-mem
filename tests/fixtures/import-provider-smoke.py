"""Real bundled Node CLI + disposable bundled worker; vendor HTTP is synthetic."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.request import Request, urlopen

REPO = Path(os.environ.get('CLAUDE_MEM_IMPORT_TEST_PACKAGE', Path(__file__).resolve().parents[2])).resolve()
BUN = os.environ.get('BUN_BIN') or shutil.which('bun')
assert BUN, 'Install Bun or set BUN_BIN.'
NODE = shutil.which('node')
PROJECT = ' import,project '
events = []
mode = 'normal'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def memory(id, **extra):
    return dict(id=id, memory='Synthetic ' + id + ' remembers the violet lighthouse.',
                isLatest=True, isForgotten=False, isInference=False, isStatic=True,
                version=1, metadata={'sourceOnly': 'preserved'},
                system={'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}, **extra)


class Vendor(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.headers.get('x-claude-mem-token') is None
        events.append((parsed.path, query, body))
        if mode == 'redirect':
            self.send_response(302); self.send_header('Location', '/credential-trap'); self.end_headers(); return
        if mode == 'auth-failure':
            self.send_response(401); self.end_headers(); self.wfile.write(b'synthetic-key-must-not-leak'); return
        if parsed.path == '/v3/memories/':
            assert self.headers['Authorization'] == 'Token synthetic-mem0'
            assert body == {'filters': {'user_id': 'fixture-user'}, 'show_expired': False}
            user = 'wrong-user' if mode == 'wrong-user' else 'fixture-user'
            row = dict(id='m1', memory='Mem0 imported synthetic saffron lighthouse.', user_id=user,
                       created_at='2026-01-01T00:00:00Z', metadata={'original': True})
            value = {'count': 3, 'next': None, 'previous': None, 'results': [row,
                     dict(row, id='m2', expiration_date='2020-01-01'), dict(row, id='m3', replaced_by='m1')]}
        elif parsed.path.endswith('/list/documents'):
            assert body == {'include': {'content': True}}
            value = {'documents': [dict(id='doc1', content='Original document text and provenance.',
                     metadata={'original': 'document'}, system={'status': 'queued' if mode == 'unready' else 'done',
                     'createdAt': '2026-01-01T00:00:00Z'})],
                     'pagination': {'totalItems': 1, 'hasMore': False, 'nextCursor': None}}
        else:
            assert self.headers['Authorization'] == 'Bearer synthetic-supermemory'
            assert parsed.path == '/ns/fixture_namespace/list/memories'
            assert body == {'include': {'forgotten': False}}
            assert query['sort'] == ['createdAt'] and query['order'] == ['asc']
            if 'cursor' not in query:
                assert query['page'] == ['1']
                value = {'memories': [memory('s1'), dict(memory('old'), isLatest=False)],
                         'pagination': {'totalItems': 4, 'hasMore': True, 'nextCursor': 'opaque+/=&'}}
            else:
                assert query['cursor'] == ['opaque+/=&']
                value = {'memories': [memory('s2'), dict(memory('forgotten'), isForgotten=True)],
                         'pagination': {'totalItems': 0, 'hasMore': False, 'nextCursor': None}}
                if mode == 'incomplete': value['memories'] = [memory('s2')]
        data = json.dumps(value).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)


with tempfile.TemporaryDirectory(prefix='provider import ') as directory:
    root = Path(directory)
    port = free_port()
    vendor = ThreadingHTTPServer(('127.0.0.1', 0), Vendor)
    thread = threading.Thread(target=vendor.serve_forever, daemon=True); thread.start()
    settings = dict(CLAUDE_MEM_WORKER_PORT=str(port), CLAUDE_MEM_WORKER_HOST='127.0.0.1',
                    CLAUDE_MEM_WORKER_AUTOSTART='false', CLAUDE_MEM_RUNTIME='worker',
                    CLAUDE_MEM_CHROMA_ENABLED='false', CLAUDE_MEM_OBSERVER_ENABLED='false',
                    CLAUDE_MEM_TRANSCRIPTS_ENABLED='false', CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH='false',
                    CLAUDE_MEM_AUTO_UPDATE='false', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED='false',
                    CLAUDE_MEM_NOTION_ENABLED='false', CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED='false',
                    CLAUDE_MEM_CLOUD_SYNC_HUB_URL='', CLAUDE_MEM_MEMORY_WATCH_ROOTS='',
                    CLAUDE_MEM_LOCAL_API_TOKEN='synthetic-local-token', CLAUDE_MEM_EXCLUDED_PROJECTS='')
    (root / 'settings.json').write_text(json.dumps(settings))
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR', 'SystemRoot') if k in os.environ}
    env.update(settings)
    env.pop('CLAUDE_MEM_EXCLUDED_PROJECTS', None)
    env.update(HOME=str(root), CLAUDE_MEM_DATA_DIR=str(root), CLAUDE_CONFIG_DIR=str(root/'config'),
               DO_NOT_TRACK='1', CLAUDE_MEM_TELEMETRY='false', OTEL_SDK_DISABLED='true')
    preload = root / 'vendor-fixture.mjs'
    preload.write_text('const original=globalThis.fetch; let dropped=false; globalThis.fetch=async(url,init)=>{const parsed=new URL(url); '
                       'if(["api.mem0.ai","api.supermemory.ai"].includes(parsed.hostname)) { parsed.protocol="http:"; '
                       f'parsed.host="127.0.0.1:{vendor.server_port}"; '
                       'return original(parsed,init);} const response=await original(url,init); '
                       'if(process.env.IMPORT_FIXTURE_DROP_ACK && !dropped && parsed.pathname==="/api/memory/save") '
                       '{dropped=true; await response.text(); throw new Error("Lost response fixture");} return response;};')
    log = (root / 'worker.log').open('w')
    worker = subprocess.Popen([BUN, '-e', 'const {WorkerService}=require("./plugin/scripts/worker-service.cjs"); '
                               'new WorkerService().start().catch(e=>{console.error(e);process.exit(1)});'],
                              cwd=REPO, env=env, stdout=log, stderr=log)
    def call(path, body):
        request = Request(f'http://127.0.0.1:{port}'+path, data=json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json', 'x-claude-mem-token': 'synthetic-local-token'})
        return json.load(urlopen(request, timeout=5))

    def rows():
        with sqlite3.connect(root/'claude-mem.db') as db:
            return db.execute('SELECT id, project, narrative, metadata FROM observations ORDER BY id').fetchall()

    def run(provider='supermemory', *flags, success=True, account='fixture-account', drop_ack=False, client_data=None):
        cli_env = dict(env, MEM0_API_KEY='synthetic-mem0', SUPERMEMORY_API_KEY='synthetic-supermemory')
        if drop_ack: cli_env['IMPORT_FIXTURE_DROP_ACK'] = '1'
        if client_data: cli_env['CLAUDE_MEM_DATA_DIR'] = str(client_data)
        args = ['import', '--from', provider, '--source-account', account, '--project', PROJECT]
        args += ['--user', 'fixture-user'] if provider == 'mem0' else ['--namespace', 'fixture_namespace']
        result = subprocess.run([NODE, '--import', str(preload), str(REPO/'dist/npx-cli/index.js'), *args, *flags],
                                cwd=root, env=cli_env, capture_output=True, text=True, timeout=30)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        assert 'synthetic-key-must-not-leak' not in result.stderr
        assert 'synthetic-supermemory' not in result.stdout + result.stderr
        assert 'synthetic-mem0' not in result.stdout + result.stderr
        return result

    try:
        deadline = time.monotonic() + 45
        while True:
            if worker.poll() is not None:
                log.flush(); raise RuntimeError((root/'worker.log').read_text()[-3000:])
            try:
                request = Request(f'http://127.0.0.1:{port}/api/readiness', headers={'x-claude-mem-token':'synthetic-local-token'})
                if urlopen(request, timeout=1).status == 200: break
            except OSError:
                if time.monotonic() > deadline: raise TimeoutError('Worker not ready')
                time.sleep(0.1)
        assert 'Dry run complete' in run('supermemory', '--dry-run').stdout
        assert rows() == []
        assert '2 new' in run().stdout
        saved = rows(); assert len(saved) == 2 and all(r[1] == PROJECT for r in saved)
        for r in saved:
            metadata = json.loads(r[3]); assert metadata['platformSource'] == 'supermemory'
            assert metadata['importSource']['record']['system']['createdAt'] == '2026-01-01T00:00:00Z'
        foreign = call('/api/memory/save', {'project': 'other', 'text': 'Foreign project lighthouse marker.'})['id']
        for i in range(25): call('/api/memory/save', {'project': PROJECT, 'text': f'Newer unrelated marker {i}'})
        assert '2 already imported' in run().stdout
        assert [r[0] for r in rows() if r[0] in {x[0] for x in saved}] == [r[0] for r in saved]
        recalled = call('/api/observations/batch', {'ids': [r[0] for r in saved] + [foreign], 'project': PROJECT})
        assert len(recalled) == 2 and all('violet lighthouse' in r['narrative'] for r in recalled)
        assert '1 new' in run('mem0').stdout
        assert '1 already imported' in run('mem0').stdout
        before = len(rows()); assert '1 new' in run('mem0', account='another-account').stdout
        assert len(rows()) == before + 1
        assert '1 new' in run('supermemory', '--documents').stdout
        before = len(rows())
        run('supermemory', success=False, account='interrupted', drop_ack=True)
        assert len(rows()) == before + 1
        recovery = run('supermemory', account='interrupted')
        assert '1 new, 1 already imported' in recovery.stdout
        assert len(rows()) == before + 2
        for bad in ['wrong-user', 'incomplete', 'unready', 'auth-failure', 'redirect']:
            mode = bad; before = len(rows())
            run('mem0' if bad == 'wrong-user' else 'supermemory', *(['--documents'] if bad == 'unready' else []), success=False)
            assert len(rows()) == before
        mode = 'normal'
        denied_client = root / 'denied-client'; denied_client.mkdir()
        (denied_client / 'settings.json').write_text(json.dumps({**settings, 'CLAUDE_MEM_LOCAL_API_TOKEN': 'wrong-token'}))
        before = len(rows())
        run('supermemory', account='denied', client_data=denied_client, success=False)
        assert len(rows()) == before
        (root / 'settings.json').write_text(json.dumps({**settings, 'CLAUDE_MEM_EXCLUDED_PROJECTS': str(root)}))
        run('supermemory', account='excluded', success=False)
        assert len(rows()) == before
        (root / 'settings.json').write_text(json.dumps(settings))
        help_result = subprocess.run([NODE, str(REPO/'dist/npx-cli/index.js'), 'import', '--help'], env=env, capture_output=True, text=True, timeout=10)
        assert help_result.returncode == 0 and '--from mem0' in help_result.stdout
        print(json.dumps({'result':'passed', 'cli':'actual bundled Node CLI', 'worker':'actual bundled worker with fresh SQLite',
                          'source':'synthetic HTTP only', 'checks':['both providers','opaque pagination','dry run','exact replay after 25 newer records',
                          'account isolation','literal project and scoped retrieval','raw provenance','document import',
                          'lost acknowledgement recovery','wrong owner','incomplete source','unready document',
                          'source auth failure redaction','source redirect refusal','destination auth refusal','excluded-project refusal','help'],
                          'observations':len(rows()),'vendor_requests':len(events)}))
    finally:
        worker.terminate()
        try: worker.wait(timeout=10)
        except subprocess.TimeoutExpired: worker.kill(); worker.wait()
        log.close(); vendor.shutdown(); vendor.server_close()
