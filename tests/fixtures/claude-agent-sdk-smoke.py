import http.server,json,tempfile,pathlib,threading,subprocess,os,time,urllib.request,socket,shutil
repo=pathlib.Path(__file__).resolve().parents[2]
bun=pathlib.Path(os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun')
root=pathlib.Path(tempfile.mkdtemp(prefix='cmem-sdk-',dir=tempfile.gettempdir())).resolve();home=root/'home';data=root/'data';project=root/'project'
for p in [home,data,project]:p.mkdir()
requests=[];calls=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))));requests.append(body)
  if 'count_tokens' in self.path:
   raw=json.dumps({'input_tokens':100}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
  index=len(calls);calls.append(body)
  tools=[('save_memory',{'text':'A restore must reject snapshots missing required worker tables.','title':'SDK restore fixture'}),('search',{'query':'restore snapshots','limit':5}),('timeline',{'anchor':2,'depth_before':1,'depth_after':1}),('get_observations',{'ids':[1,2]})]
  if index<len(tools):
   name,args=tools[index];block={'type':'tool_use','id':f'toolu_fixture{index}','name':'mcp__claude-mem__'+name,'input':args};reason='tool_use'
  else:block={'type':'text','text':'A restore must reject snapshots missing required worker tables.'};reason='end_turn'
  message={'id':f'msg_fixture{index}','type':'message','role':'assistant','model':body.get('model','haiku'),'content':[block],'stop_reason':reason,'stop_sequence':None,'usage':{'input_tokens':100,'output_tokens':20,'cache_creation_input_tokens':0,'cache_read_input_tokens':0}}
  if body.get('stream'):
   start={**message,'content':[],'stop_reason':None}
   events=[('message_start',{'type':'message_start','message':start}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{**block,**({'input':{}} if block['type']=='tool_use' else {'text':''})}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(block['input'])} if block['type']=='tool_use' else {'type':'text_delta','text':block['text']}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':reason,'stop_sequence':None},'usage':{'output_tokens':20}}),('message_stop',{'type':'message_stop'})]
   raw=''.join(f'event: {name}\ndata: {json.dumps(value)}\n\n' for name,value in events).encode()
  else:raw=json.dumps(message).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
(data/'settings.json').write_text(json.dumps({'CLAUDE_MEM_WORKER_PORT':str(port),'CLAUDE_MEM_OBSERVER_ENABLED':'false','CLAUDE_MEM_CHROMA_ENABLED':'false','CLAUDE_MEM_AUTO_UPDATE':'false','CLAUDE_MEM_WORK_VIEW_AGENT':'off'}))
env={'PATH':str(bun.parent)+':'+os.environ['PATH'],'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'CLAUDE_MEM_DATA_DIR':str(data),'CLAUDE_MEM_WORKER_PORT':str(port),'DO_NOT_TRACK':'1','ANTHROPIC_API_KEY':'synthetic-key','ANTHROPIC_BASE_URL':f'http://127.0.0.1:{server.server_port}','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','ENABLE_TOOL_SEARCH':'false'}
worker=repo/'plugin/scripts/worker-service.cjs'
def request(route,payload=None):
 req=urllib.request.Request(f'http://127.0.0.1:{port}'+route,data=json.dumps(payload).encode() if payload else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
try:
 subprocess.run([bun,'--no-install',worker,'start'],cwd=repo,env=env,check=True,timeout=35)
 request('/api/memory/save',{'project':'unrelated','text':'SDK forbidden fixture must never reach the model.','title':'SDK forbidden fixture'})
 result=subprocess.run([bun,repo/'examples/claude-agent-sdk/memory.ts','--project','fixture','--server',repo/'plugin/scripts/mcp-server.cjs'],cwd=project,env=env,capture_output=True,text=True,timeout=70)
 (root/'stdout.log').write_text(result.stdout);(root/'stderr.log').write_text(result.stderr);(root/'requests.json').write_text(json.dumps(requests))
 print('Evidence',root,'exit',result.returncode,'calls',len(calls));print(result.stdout[-800:]);print(result.stderr[-1200:])
 assert result.returncode==0
 assert len(calls)==5
 assert 'SDK forbidden fixture' not in json.dumps(calls)
 assert 'SDK restore fixture' in json.dumps(calls[-1])
 # The model asked for both IDs; the get_observations result must hold the saved note and withhold the other project's.
 details=[b for m in calls[-1]['messages'] if isinstance(m.get('content'),list) for b in m['content'] if b.get('type')=='tool_result' and b.get('tool_use_id')=='toolu_fixture3']
 assert len(details)==1,'missing get_observations result'
 details_text=json.dumps(details[0])
 assert 'A restore must reject snapshots missing required worker tables.' in details_text
 assert 'SDK forbidden fixture' not in details_text
 rows=request('/api/observations?project=fixture')['items'];assert any(r['title']=='SDK restore fixture' for r in rows)
 print('Actual SDK saved, searched, inspected timeline and fetched only the selected project memory')
finally:
 subprocess.run([bun,'--no-install',worker,'stop'],cwd=repo,env=env,timeout=20)
 server.shutdown()
