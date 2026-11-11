import pathlib,tempfile,secrets,subprocess,os,socket,time,json,urllib.request,urllib.error,asyncio,shutil,sys
root=pathlib.Path(tempfile.mkdtemp(prefix='cmem-forge-live-',dir=tempfile.gettempdir())).resolve()
repo=pathlib.Path(__file__).resolve().parents[2];bun=pathlib.Path(os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun');python=sys.executable
def free():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
port,workerport,mcpport=free(),free(),free();home=root/'home';data=root/'data';home.mkdir();data.mkdir()
env={'PATH':str(bun.parent)+':'+os.environ['PATH'],'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'CLAUDE_MEM_DATA_DIR':str(data),'CLAUDE_MEM_WORKER_PORT':str(workerport),'DO_NOT_TRACK':'1','HOST':'127.0.0.1','PORT':str(port),'DATABASE_URL':f'sqlite:///{root}/gateway.db','JWT_SECRET_KEY':secrets.token_urlsafe(48),'AUTH_ENCRYPTION_SECRET':secrets.token_urlsafe(48),'BASIC_AUTH_PASSWORD':secrets.token_urlsafe(32),'DEFAULT_USER_PASSWORD':'Lab!'+secrets.token_urlsafe(32),'PLATFORM_ADMIN_EMAIL':'lab@example.com','PLATFORM_ADMIN_PASSWORD':'Lab!'+secrets.token_urlsafe(32),'AUTH_REQUIRED':'true','MCPGATEWAY_ADMIN_API_ENABLED':'true','MCPGATEWAY_UI_ENABLED':'false','SSRF_ALLOW_LOCALHOST':'true','SSRF_ALLOW_PRIVATE_NETWORKS':'true','LOG_LEVEL':'ERROR','ENABLE_METRICS':'false'}
(data/'settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT':str(workerport),'CLAUDE_MEM_OBSERVER_ENABLED':'false','CLAUDE_MEM_CHROMA_ENABLED':'false','CLAUDE_MEM_AUTO_UPDATE':'false','CLAUDE_MEM_WORK_VIEW_AGENT':'off'}))
logs=[];processes=[];worker=repo/'plugin/scripts/worker-service.cjs'
def launch(args,name):
 f=(root/name).open('w');logs.append(f);p=subprocess.Popen(args,cwd=root,env=env,stdout=f,stderr=f);processes.append(p);return p
def http(base,path,payload=None,token=None,method=None,timeout=35):
 req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})},method=method)
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r) if r.status!=204 else None
 except urllib.error.HTTPError as error:raise RuntimeError(f'{path}: HTTP {error.code} '+error.read().decode()[:1200])
base=f'http://127.0.0.1:{port}';wb=f'http://127.0.0.1:{workerport}'
try:
 subprocess.run([bun,'--no-install',worker,'start'],cwd=repo,env=env,check=True,timeout=40)
 saved=http(wb,'/api/memory/save',{'project':'forge-fixture','text':'A restore must reject snapshots missing required worker tables.','title':'ContextForge fixture'})
 foreign=http(wb,'/api/memory/save',{'project':'unrelated','text':'Unrelated restore snapshots fixture must not be returned.','title':'Unrelated fixture'})
 print('Saved synthetic fixture',saved['id'],flush=True)
 mcp=launch([bun,'--no-install',repo/'plugin/scripts/mcp-server.cjs','--http','--port',str(mcpport)],'mcp.log')
 gateway=launch([python,'-m','mcpgateway'],'gateway.log')
 for _ in range(360):
  if gateway.poll() is not None:raise RuntimeError((root/'gateway.log').read_text()[-2200:])
  try:
   with urllib.request.urlopen(base+'/health',timeout=1) as r:
    if r.status==200:break
  except Exception:time.sleep(.25)
 else:raise RuntimeError('Gateway not ready')
 token=subprocess.check_output([python,'-m','mcpgateway.utils.create_jwt_token','--username','lab@example.com','--admin','--exp','30'],cwd=root,env=env,text=True,stderr=subprocess.PIPE).strip().splitlines()[-1]
 g=http(base,'/v1/gateways',{'name':'claude-mem-fixture','url':f'http://127.0.0.1:{mcpport}/mcp','transport':'STREAMABLEHTTP','visibility':'private'},token)
 (root/'gateway-response.json').write_text(json.dumps(g));print('Registered private gateway',g['id'],flush=True)
 tools=http(base,'/v1/tools',token=token);(root/'tools.json').write_text(json.dumps(tools));print('Tools type',type(tools).__name__,flush=True)
 selected=[t for t in tools if t['gatewayId']==g['id'] and t['originalName'] in ['search','timeline','get_observations']]
 assert len(selected)==3
 virtual=http(base,'/v1/servers',{'server':{'name':'claude-mem-read-fixture','associated_tools':[t['id'] for t in selected]},'visibility':'private'},token)
 print('Registered private read-only virtual server',flush=True)
 (root/'virtual.json').write_text(json.dumps(virtual))
 virtual_id=virtual['id']
 async def recall():
  import httpx2
  from mcp import ClientSession
  from mcp.client.streamable_http import streamable_http_client
  async with httpx2.AsyncClient(headers={'Authorization':'Bearer '+token},timeout=30) as client:
   async with streamable_http_client(base+'/servers/'+virtual_id+'/mcp',http_client=client) as streams:
    async with ClientSession(streams[0],streams[1]) as session:
     await session.initialize()
     available=await session.list_tools();assert {t.name for t in available.tools}=={t['name'] for t in selected};print('Published tools',[t.name for t in available.tools],flush=True)
     search_name=next(t['name'] for t in selected if t['originalName']=='search')
     detail_name=next(t['name'] for t in selected if t['originalName']=='get_observations')
     found=await session.call_tool(search_name,{'query':'restore snapshots','project':'forge-fixture','limit':5})
     assert not found.is_error,found
     index=' '.join(getattr(c,'text','') for c in found.content)
     assert 'ContextForge fixture' in index,index
     assert 'Unrelated fixture' not in index,index
     timeline_name=next(t['name'] for t in selected if t['originalName']=='timeline')
     timeline=await session.call_tool(timeline_name,{'anchor':saved['id'],'project':'forge-fixture','depth_before':1,'depth_after':1})
     assert not timeline.is_error,timeline
     details=await session.call_tool(detail_name,{'ids':[saved['id'],foreign['id']],'project':'forge-fixture'})
     assert not details.is_error,details
     text=' '.join(getattr(c,'text','') for c in details.content)
     assert 'A restore must reject snapshots missing required worker tables.' in text,text
     assert 'Unrelated restore snapshots fixture' not in text,text
     print('Retrieved exact saved text through real ContextForge',flush=True)
 try:
  urllib.request.urlopen(base+'/v1/tools',timeout=5)
 except urllib.error.HTTPError as error:
  assert error.code in (401,403),error.code
 else:raise AssertionError('Gateway accepted an unauthenticated API request')
 asyncio.run(recall())
 http(base,'/v1/servers/'+virtual_id,token=token,method='DELETE')
 http(base,'/v1/gateways/'+g['id'],token=token,method='DELETE')
 assert http(wb,'/api/observation/'+str(saved['id']))['title']=='ContextForge fixture'
 print('Disconnected gateway and server without deleting saved memory',flush=True)
 print('Evidence',root,flush=True)
finally:
 for p in reversed(processes):
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
 subprocess.run([bun,'--no-install',worker,'stop'],cwd=repo,env=env,timeout=20)
 for f in logs:f.close()
