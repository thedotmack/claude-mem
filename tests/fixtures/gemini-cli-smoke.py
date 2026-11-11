import http.server,json,tempfile,pathlib,threading,subprocess,os,time,urllib.request,urllib.parse,socket,shutil
repo=pathlib.Path(__file__).resolve().parents[2]
bun=pathlib.Path(os.environ.get('BUN_BIN') or shutil.which('bun') or 'bun')
root=pathlib.Path(tempfile.mkdtemp(prefix='cmem-gemini-live-',dir=tempfile.gettempdir())).resolve();home=root/'home';project=root/'project';data=root/'data'
for p in [home,project,data]:p.mkdir()
(home/'.gemini').mkdir();(project/'fixture.txt').write_text('Require all worker tables before restoring a snapshot.\n')
requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0)))); requests.append({'path':self.path,'body':body})
  if 'chat/completions' in self.path:
   content='<observation><type>discovery</type><title>Gemini capture fixture</title><narrative>Require all worker tables before restoring a snapshot.</narrative><facts><fact>Reject incomplete snapshots.</fact></facts><concepts><concept>how-it-works</concept></concepts><files_read><file>'+str(project/'fixture.txt')+'</file></files_read><files_modified></files_modified></observation>'
   if 'summary' in json.dumps(body.get('messages',[])[-1:]).lower() and 'summarize' in json.dumps(body.get('messages',[])[-1:]).lower():content='<summary><request>Read fixture</request><investigated>fixture</investigated><learned>Require worker tables</learned><completed>Read fixture</completed><next_steps>None</next_steps><notes>synthetic</notes></summary>'
   reply={'id':'fixture-completion','object':'chat.completion','model':'fixture','choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}
  elif 'countTokens' in self.path:reply={'totalTokens':100}
  else:
   has_response=any('functionResponse' in part for c in body.get('contents',[]) for part in c.get('parts',[]))
   parts=[{'text':'Synthetic file was read.'}] if has_response else [{'functionCall':{'name':'read_file','args':{'file_path':str(project/'fixture.txt')}}}]
   reply={'candidates':[{'content':{'role':'model','parts':parts},'finishReason':'STOP','index':0}],'usageMetadata':{'promptTokenCount':10,'candidatesTokenCount':5,'totalTokenCount':15}}
  raw=('data: '+json.dumps(reply)+'\n\n').encode() if 'streamGenerateContent' in self.path else json.dumps(reply).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream' if 'streamGenerateContent' in self.path else 'application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
settings={'CLAUDE_MEM_CHROMA_ENABLED':'false','CLAUDE_MEM_AUTO_UPDATE':'false','CLAUDE_MEM_WORK_VIEW_AGENT':'off','CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH':'false','CLAUDE_MEM_PROVIDER':'openai-compatible','CLAUDE_MEM_OPENAI_COMPAT_API_KEY':'synthetic-key','CLAUDE_MEM_OPENAI_COMPAT_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','CLAUDE_MEM_OPENAI_COMPAT_MODEL':'fixture','CLAUDE_MEM_WORKER_PORT':str(port)}
(data/'settings.json').write_text(json.dumps(settings));(home/'.gemini/settings.json').write_text(json.dumps({'security':{'auth':{'selectedType':'gemini-api-key'}},'telemetry':{'enabled':False}}))
env={'PATH':str(bun.parent)+':'+os.environ['PATH'],'HOME':str(home),'CLAUDE_CONFIG_DIR':str(home/'.claude'),'CODEX_HOME':str(home/'.codex'),'CLAUDE_MEM_DATA_DIR':str(data),'CLAUDE_MEM_WORKER_PORT':str(port),'CLAUDE_PLUGIN_ROOT':str(repo/'plugin'),'DO_NOT_TRACK':'1','GEMINI_API_KEY':'synthetic-key','GOOGLE_GEMINI_BASE_URL':f'http://127.0.0.1:{server.server_port}','GEMINI_CLI_TRUST_WORKSPACE':'true'}
worker=repo/'plugin/scripts/worker-service.cjs'
def get(route):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}'+route,timeout=5) as r:return json.load(r)
try:
 subprocess.run([bun,'--no-install',worker,'start'],env=env,cwd=repo,check=True,timeout=35)
 subprocess.run([bun,'--no-install',worker,'gemini','install'],env=env,cwd=repo,check=True,timeout=15)
 for run in range(2):
  result=subprocess.run([os.environ.get('GEMINI_BIN') or shutil.which('gemini') or 'gemini','-p','Read fixture.txt and report its instruction.','--model','gemini-2.5-flash','--approval-mode','yolo','--output-format','json'],cwd=project,env=env,capture_output=True,text=True,timeout=55)
  (root/f'run-{run}.out').write_text(result.stdout);(root/f'run-{run}.err').write_text(result.stderr)
  if result.returncode:raise RuntimeError(result.stderr[-2000:])
  if run==0:
   for _ in range(80):
    rows=get('/api/observations?project=project');rows=rows.get('items',[]) if isinstance(rows,dict) else rows
    if any(r.get('title')=='Gemini capture fixture' for r in rows):break
    time.sleep(.25)
   else:raise RuntimeError('No captured observation saved')
   print('Captured observation saved',[(r.get('id'),r.get('project')) for r in rows if r.get('title')=='Gemini capture fixture'])
 second=json.dumps([r['body'] for r in requests if 'streamGenerateContent' in r['path']][-2:],ensure_ascii=False)
 assert 'Gemini capture fixture' in second,'Saved observation missing from second session context'
 print('Second real Gemini session received saved memory in context')
 (root/'requests.json').write_text(json.dumps(requests))
 print('Evidence',root)
 observer_calls=sum('chat/completions' in r['path'] for r in requests)
 settings['CLAUDE_MEM_EXCLUDED_PROJECTS']=str(project)
 (data/'settings.json').write_text(json.dumps(settings))
 excluded=env
 result=subprocess.run([os.environ.get('GEMINI_BIN') or shutil.which('gemini') or 'gemini','-p','Read fixture.txt.','--model','gemini-2.5-flash','--approval-mode','yolo','--output-format','json'],cwd=project,env=excluded,capture_output=True,text=True,timeout=55)
 assert result.returncode==0,result.stderr[-2000:]
 assert sum('chat/completions' in r['path'] for r in requests)==observer_calls,'Excluded project triggered observer inference'
 print('Excluded-project run completed with zero observer requests')
finally:
 subprocess.run([bun,'--no-install',worker,'stop'],env=env,cwd=repo,timeout=20)
 server.shutdown()
