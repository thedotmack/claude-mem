import pathlib,tempfile,subprocess,json,os,socket,urllib.request,shutil
repo=pathlib.Path(__file__).resolve().parents[2];bun=pathlib.Path(os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun');root=pathlib.Path(tempfile.mkdtemp(prefix='cmem-eliza-',dir=tempfile.gettempdir())).resolve();home=root/'home';data=root/'data';project=root/'project'
for p in [home,data,project]:p.mkdir()
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
(data/'settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT':str(port),'CLAUDE_MEM_OBSERVER_ENABLED':'false','CLAUDE_MEM_CHROMA_ENABLED':'false','CLAUDE_MEM_AUTO_UPDATE':'false','CLAUDE_MEM_WORK_VIEW_AGENT':'off'}))
env={'PATH':str(bun.parent)+':'+os.environ['PATH'],'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'CLAUDE_MEM_DATA_DIR':str(data),'CLAUDE_MEM_WORKER_PORT':str(port),'DO_NOT_TRACK':'1','MCP_SCHEMA_CACHE_ENABLED':'false','LOG_LEVEL':'error'}
worker=repo/'plugin/scripts/worker-service.cjs'
try:
 subprocess.run([bun,'--no-install',worker,'start'],env=env,cwd=repo,check=True,timeout=40)
 # The other project's record matches the example's query, so a leak through search or timeline would show.
 foreign='Other project restore snapshots fixture must not appear in the example output.'
 req=urllib.request.Request(f'http://127.0.0.1:{port}/api/memory/save',data=json.dumps({'project':'other','text':foreign,'title':'Other project restore snapshots fixture'}).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=5) as r:foreign_id=json.load(r)['id']
 result=subprocess.run([os.environ.get('NODE_BIN') or shutil.which('node') or 'node',repo/'examples/elizaos/memory.mjs','--project','eliza-fixture','--server',repo/'plugin/scripts/mcp-server.cjs','--worker',f'http://127.0.0.1:{port}','--withheld-id',str(foreign_id)],env=env,cwd=project,capture_output=True,text=True,timeout=85)
 (root/'stdout.log').write_text(result.stdout);(root/'stderr.log').write_text(result.stderr)
 print('Evidence',root,'exit',result.returncode);print(result.stdout[-1200:]);print(result.stderr[-1200:])
 assert result.returncode==0
 assert 'A restore must reject snapshots missing required worker tables.' in result.stdout
 for tool in ['--- search','--- timeline','--- get_observations']:assert tool in result.stdout,tool
 assert 'Other project restore snapshots fixture' not in result.stdout,'another project leaked into search, timeline or details'
 assert result.stdout.rstrip().endswith('No selected observations found.'),'the other project ID was not withheld'
 print('Real elizaOS runtime and MCP service saved and recalled the exact project memory')
 subprocess.run([bun,'--no-install',worker,'stop'],env=env,cwd=repo,check=True,timeout=20)
 failed=subprocess.run([os.environ.get('NODE_BIN') or shutil.which('node') or 'node',repo/'examples/elizaos/memory.mjs','--project','eliza-fixture','--server',repo/'plugin/scripts/mcp-server.cjs','--worker',f'http://127.0.0.1:{port}'],env=env,cwd=project,capture_output=True,text=True,timeout=10)
 assert failed.returncode!=0,'Stopped worker was reported as a successful operation'
 print('Stopped worker fails the explicit save without reporting success')
finally:subprocess.run([bun,'--no-install',worker,'stop'],env=env,cwd=repo,timeout=20)
