"use strict";var cs=Object.create;var q=Object.defineProperty;var _s=Object.getOwnPropertyDescriptor;var us=Object.getOwnPropertyNames;var ls=Object.getPrototypeOf,ps=Object.prototype.hasOwnProperty;var ms=(s,e)=>{for(var t in e)q(s,t,{get:e[t],enumerable:!0})},Be=(s,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of us(e))!ps.call(s,n)&&n!==t&&q(s,n,{get:()=>e[n],enumerable:!(r=_s(e,n))||r.enumerable});return s};var H=(s,e,t)=>(t=s!=null?cs(ls(s)):{},Be(e||!s||!s.__esModule?q(t,"default",{value:s,enumerable:!0}):t,s)),Es=s=>Be(q({},"__esModule",{value:!0}),s);var Zs={};ms(Zs,{generateContext:()=>$e,generateContextWithStats:()=>me});module.exports=Es(Zs);var is=H(require("path"),1),as=require("os"),ds=require("fs");var Ne=require("bun:sqlite");var E=require("path"),be=require("os"),x=require("fs");var We=require("url");var v=require("fs"),Xe=require("path");var gs=null;function Ts(s){return(gs??process.stderr.write.bind(process.stderr))(s)}function ge(s){Ts(s)}var Te=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Te||{}),fe=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=j.logsDir();(0,v.existsSync)(e)||(0,v.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,Xe.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=j.settings();if((0,v.existsSync)(e)){let t=(0,v.readFileSync)(e,"utf-8"),n=(JSON.parse(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Te[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let r=t;if(typeof t=="string")try{r=JSON.parse(t)}catch{r=t}if(e==="Bash"&&r.command)return`${e}(${r.command})`;if(r.file_path)return`${e}(${r.file_path})`;if(r.notebook_path)return`${e}(${r.notebook_path})`;if(e==="Glob"&&r.pattern)return`${e}(${r.pattern})`;if(e==="Grep"&&r.pattern)return`${e}(${r.pattern})`;if(r.url)return`${e}(${r.url})`;if(r.query)return`${e}(${r.query})`;if(e==="Task"){if(r.subagent_type)return`${e}(${r.subagent_type})`;if(r.description)return`${e}(${r.description})`}return e==="Skill"&&r.skill?`${e}(${r.skill})`:e==="LSP"&&r.operation?`${e}(${r.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),r=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${r}-${n} ${o}:${i}:${a}.${d}`}log(e,t,r,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Te[e].padEnd(5),d=t.padEnd(6),l="";n?.correlationId?l=`[${n.correlationId}] `:n?.sessionId&&(l=`[session-${n.sessionId}] `);let u="";if(o!=null)if(o instanceof Error)u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{u=`
`+JSON.stringify(o,null,2)}catch{u=" "+this.formatData(o)}else u=" "+this.formatData(o);let p="";if(n){let{sessionId:m,memorySessionId:f,correlationId:b,...S}=n;Object.keys(S).length>0&&(p=` {${Object.entries(S).map(([h,O])=>`${h}=${O}`).join(", ")}}`)}let g=`[${i}] [${a}] [${d}] ${l}${r}${p}${u}`;if(this.logFilePath)try{(0,v.appendFileSync)(this.logFilePath,g+`
`,"utf8")}catch(m){ge(`[LOGGER] Failed to write to log file: ${m instanceof Error?m.message:String(m)}
`)}else ge(g+`
`)}debug(e,t,r,n){this.log(0,e,t,r,n)}info(e,t,r,n){this.log(1,e,t,r,n)}warn(e,t,r,n){this.log(2,e,t,r,n)}error(e,t,r,n){this.log(3,e,t,r,n)}dataIn(e,t,r,n){this.info(e,`\u2192 ${t}`,r,n)}dataOut(e,t,r,n){this.info(e,`\u2190 ${t}`,r,n)}success(e,t,r,n){this.info(e,`\u2713 ${t}`,r,n)}failure(e,t,r,n){this.error(e,`\u2717 ${t}`,r,n)}timing(e,t,r,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${r}ms`})}happyPathError(e,t,r,n,o=""){let l=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=l?`${l[1].split("/").pop()}:${l[2]}`:"unknown",p={...r,location:u};return this.warn(e,`[HAPPY-PATH] ${t}`,p,n),o}},_=new fe;var Is={};function fs(){return typeof __dirname<"u"?__dirname:(0,E.dirname)((0,We.fileURLToPath)(Is.url))}var bs=fs();function Ss(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let s=(0,E.join)((0,be.homedir)(),".claude-mem"),e=(0,E.join)(s,"settings.json");try{if((0,x.existsSync)(e)){let t=JSON.parse((0,x.readFileSync)(e,"utf-8")),r=t.env??t;if(r.CLAUDE_MEM_DATA_DIR)return r.CLAUDE_MEM_DATA_DIR}}catch{}return s}var R=Ss(),P=process.env.CLAUDE_CONFIG_DIR||(0,E.join)((0,be.homedir)(),".claude"),ar=(0,E.join)(P,"plugins","marketplaces","thedotmack"),hs=(0,E.join)(R,"archives"),Os=(0,E.join)(R,"logs"),Rs=(0,E.join)(R,"trash"),As=(0,E.join)(R,"backups"),Ns=(0,E.join)(R,"modes"),dr=(0,E.join)(R,"settings.json"),Ve=(0,E.join)(R,"claude-mem.db"),Cs=(0,E.join)(R,"vector-db"),Ye=(0,E.join)(R,"observer-sessions"),Se=(0,E.basename)(Ye),cr=(0,E.join)(P,"settings.json"),_r=(0,E.join)(P,"commands"),ur=(0,E.join)(P,"CLAUDE.md");function Ke(s){(0,x.mkdirSync)(s,{recursive:!0})}function qe(){return(0,E.join)(bs,"..")}var j={dataDir:()=>R,workerPid:()=>(0,E.join)(R,"worker.pid"),serverBetaPid:()=>(0,E.join)(R,".server-beta.pid"),serverBetaPort:()=>(0,E.join)(R,".server-beta.port"),serverBetaRuntime:()=>(0,E.join)(R,".server-beta.runtime.json"),settings:()=>(0,E.join)(R,"settings.json"),database:()=>(0,E.join)(R,"claude-mem.db"),chroma:()=>(0,E.join)(R,"chroma"),combinedCerts:()=>(0,E.join)(R,"combined_certs.pem"),transcriptsConfig:()=>(0,E.join)(R,"transcript-watch.json"),transcriptsState:()=>(0,E.join)(R,"transcript-watch-state.json"),corpora:()=>(0,E.join)(R,"corpora"),supervisorRegistry:()=>(0,E.join)(R,"supervisor.json"),envFile:()=>(0,E.join)(R,".env"),logsDir:()=>Os,archives:()=>hs,trash:()=>Rs,backups:()=>As,modes:()=>Ns,vectorDb:()=>Cs,observerSessions:()=>Ye};var tt=require("crypto");var Qe=require("os"),ze=H(require("path"),1),Ze=require("child_process");var Q=require("fs"),J=H(require("path"),1);var G={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Je(s){let e=J.default.join(s,".git"),t;try{t=(0,Q.statSync)(e)}catch(u){return u instanceof Error&&u.code!=="ENOENT"&&_.warn("GIT","Unexpected error checking .git",{error:u instanceof Error?u.message:String(u)}),G}if(!t.isFile())return G;let r;try{r=(0,Q.readFileSync)(e,"utf-8").trim()}catch(u){return _.warn("GIT","Failed to read .git file",{error:u instanceof Error?u.message:String(u)}),G}let n=r.match(/^gitdir:\s*(.+)$/);if(!n)return G;let i=n[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return G;let a=i[1],d=J.default.basename(s),l=J.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:l}}function et(s){return s==="~"||s.startsWith("~/")?s.replace(/^~/,(0,Qe.homedir)()):s}function Ls(s){try{return(0,Ze.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:s,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch{return null}}function Ms(s){if(!s||s.trim()==="")return _.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:s}),"unknown-project";let e=et(s),r=Ls(e)??e,n=ze.default.basename(r);if(n===""){if(process.platform==="win32"){let i=s.match(/^([A-Z]):\\/i);if(i){let d=`drive-${i[1].toUpperCase()}`;return _.info("PROJECT_NAME","Drive root detected",{cwd:s,projectName:d}),d}}return _.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:s}),"unknown-project"}return n}function he(s){let e=Ms(s);if(!s)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let t=et(s),r=Je(t);if(r.isWorktree&&r.parentProjectName){let n=`${r.parentProjectName}/${e}`;return{primary:n,parent:r.parentProjectName,isWorktree:!0,allProjects:[r.parentProjectName,n]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}function Oe(s){return(0,tt.createHash)("sha256").update(s.join("\0")).digest("hex").slice(0,16)}function y(s){return JSON.stringify(s??[])}function Ds(s){return!!(s.subtitle||(s.facts?.length??0)>0||(s.concepts?.length??0)>0||(s.files_read?.length??0)>0||(s.files_modified?.length??0)>0)}function M(s){return s||""}function z(s){if(!s)return"[]";try{let e=JSON.parse(s);return JSON.stringify(Array.isArray(e)?e:[])}catch{return s}}function Z(s,e,t){let r=typeof e=="object"&&e!==null?e:{title:e,narrative:t??null};return Oe([s||"",M(r.title),M(r.narrative)])}function ee(s,e){return M(e.title)===M(s.title)&&M(e.narrative)===M(s.narrative)&&M(e.subtitle)===M(s.subtitle)&&z(e.facts)===y(s.facts)&&z(e.concepts)===y(s.concepts)&&z(e.files_read)===y(s.files_read)&&z(e.files_modified)===y(s.files_modified)}function te(s,e,t){let r=typeof e=="object"&&e!==null?e:{title:e,narrative:t??null},n=[s||"",M(r.title),M(r.narrative)];return Ds(r)?Oe([...n,r.subtitle||"",y(r.facts),y(r.concepts),y(r.files_read),y(r.files_modified)]):Oe(n)}function Re(s){if(!s)return[];try{let e=JSON.parse(s);return Array.isArray(e)?e:[String(e)]}catch{return[s]}}var N="claude";function vs(s){return s.trim().toLowerCase().replace(/\s+/g,"-")}function w(s){if(!s)return N;let e=vs(s);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:N}function st(s){let e=["claude","codex","cursor"];return[...s].sort((t,r)=>{let n=e.indexOf(t),o=e.indexOf(r);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:t.localeCompare(r)})}function rt(s,e,t,r){let n=Date.now()-r;return s.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${N}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(e,t,n)??void 0}var it=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],nt=new RegExp(`<(${it.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),at=/<system-reminder>[\s\S]*?<\/system-reminder>/g,ot=100;function ys(s){let e=Object.fromEntries(it.map(n=>[n,0]));nt.lastIndex=0;let t=0,r=s.replace(nt,(n,o)=>(e[o]=(e[o]??0)+1,t+=1,""));return t>ot&&_.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:ot,contentLength:s.length}),{stripped:r.trim(),counts:e}}function dt(s){return ys(s).stripped}var Us=["task-notification"],Cr=new RegExp(`^\\s*<(${Us.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Ir=256*1024;var Ae=4e3;function se(s){let e=s.trim(),r=dt(s).trim()||e;return r.length<=Ae?r:(_.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:r.length,storedLength:Ae}),`${r.slice(0,Ae-1)}\u2026`)}function xs(s,e){return{customTitle:s,platformSource:e?w(e):void 0}}var re=class{db;constructor(e=Ve){e instanceof Ne.Database?this.db=e:(e!==":memory:"&&Ke(R),this.db=new Ne.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.db.run("PRAGMA journal_size_limit = 4194304")),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn()}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),r=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!r)){if(r)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),_.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){_.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),r=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>r.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),_.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),_.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),_.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),_.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1&&r.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}_.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),_.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}_.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),_.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}_.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),_.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}_.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);let r=`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `,n=`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;try{this.db.run(r),this.db.run(n)}catch(o){o instanceof Error?_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}_.debug("DB","Creating pending_messages table"),this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),_.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;_.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,r=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),_.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(_.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};r("sdk_sessions","claude_session_id","content_session_id")&&t++,r("sdk_sessions","sdk_session_id","memory_session_id")&&t++,r("pending_messages","claude_session_id","content_session_id")&&t++,r("observations","sdk_session_id","memory_session_id")&&t++,r("session_summaries","sdk_session_id","memory_session_id")&&t++,r("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?_.debug("DB",`Successfully renamed ${t} session ID columns`):_.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),_.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;_.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(T=>T.name==="metadata"),n=t.some(T=>T.name==="content_hash"),o=r?`,
        metadata TEXT`:"",i=r?", metadata":"",a=n?`,
        content_hash TEXT`:"",d=n?", content_hash":"",l=`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL${o}${a},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,u=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${i}${d}
      FROM observations
    `,p=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,g=`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let m=`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,f=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,b=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,S=`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `;try{this.recreateObservationsWithCascade(l,u,p,g),this.recreateSessionSummariesWithCascade(m,f,b,S),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),_.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(T){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),T instanceof Error?T:new Error(String(T))}}recreateObservationsWithCascade(e,t,r,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(r),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,r,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(r),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),_.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),_.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${N}'`),_.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${N}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),r=e.some(n=>n.name==="relevance_count");t&&r||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(r=>r.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(i=>i.name==="agent_type"),n=t.some(i=>i.name==="agent_id");r||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        DELETE FROM pending_messages
         WHERE id IN (
           SELECT id
             FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY content_session_id, tool_use_id
                        ORDER BY CASE status
                          WHEN 'processing' THEN 0
                          WHEN 'pending' THEN 1
                          ELSE 2
                        END, id
                      ) AS duplicate_rank
                 FROM pending_messages
                WHERE tool_use_id IS NOT NULL
             )
            WHERE duplicate_rank > 1
           )
      `),this.db.run(`
        -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
        -- only for rows that came from a concrete tool-use event.
        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
        ON pending_messages(content_session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()),this.db.run("COMMIT")}catch(n){throw this.db.run("ROLLBACK"),n}}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(o=>o.name==="memory_session_id"),n=t.some(o=>o.name==="content_hash");if(!r||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        UPDATE observations
           SET content_hash = '__null_migration_' || id || '__'
         WHERE content_hash IS NULL
      `),this.db.run(`
        DELETE FROM observations
         WHERE id IN (
           SELECT id
             FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY memory_session_id, content_hash
                        ORDER BY id
                      ) AS duplicate_rank
                 FROM observations
             )
            WHERE duplicate_rank > 1
         )
      `),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString()),this.db.run("COMMIT")}catch(o){throw this.db.run("ROLLBACK"),o}}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),_.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}markSessionCompleted(e){let t=Date.now(),r=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(r,t,e)}ensureMemorySessionIdRegistered(e,t,r){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),_.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:t})),typeof r=="number"&&n.worker_port!==r&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(r,e)}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentSummariesWithSessionInfo(e,t=3){return this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentObservations(e,t=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getAllRecentObservations(e=100){return this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${N}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentSummaries(e=50){return this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${N}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentUserPrompts(e=100){return this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${N}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let t=e?w(e):void 0,r=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[Se];return t&&(r+=" AND COALESCE(platform_source, ?) = ?",n.push(N,t)),r+=" ORDER BY project ASC",this.db.prepare(r).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${N}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${N}'), project
      ORDER BY latest_epoch DESC
    `).all(Se),t=[],r=new Set,n={};for(let i of e){let a=w(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),r.has(i.project)||(r.add(i.project),t.push(i.project))}let o=st(Object.keys(n));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${N}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}findRecentDuplicateUserPrompt(e,t,r){return rt(this.db,e,se(t),r)}getRecentSessionsWithStatus(e,t=3){return this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(e,t)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o,type:i,concepts:a,files:d}=t,l=r==="relevance",u=l?"":`ORDER BY created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,p=n?`LIMIT ${n}`:"",g=e.map(()=>"?").join(","),m=[...e],f=[];if(o&&(f.push("project = ?"),m.push(o)),i)if(Array.isArray(i)){let O=i.map(()=>"?").join(",");f.push(`type IN (${O})`),m.push(...i)}else f.push("type = ?"),m.push(i);if(a){let O=Array.isArray(a)?a:[a],U=O.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");m.push(...O),f.push(`(${U.join(" OR ")})`)}if(d){let O=Array.isArray(d)?d:[d],U=O.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");O.forEach(A=>{m.push(`%${A}%`,`%${A}%`)}),f.push(`(${U.join(" OR ")})`)}let b=f.length>0?`WHERE id IN (${g}) AND ${f.join(" AND ")}`:`WHERE id IN (${g})`,T=this.db.prepare(`
      SELECT *
      FROM observations
      ${b}
      ${u}
      ${p}
    `).all(...m);if(!l)return T;let h=new Map(T.map(O=>[O.id,O]));return e.map(O=>h.get(O)).filter(O=>!!O)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let r=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),n=new Set,o=new Set;for(let i of r)Re(i.files_read).forEach(a=>n.add(a)),Re(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${N}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${N}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}getSessionIdByContentSessionId(e){return this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE content_session_id = ?
      LIMIT 1
    `).get(e)?.id??null}createSDKSession(e,t,r,n,o){let i=new Date,a=i.getTime(),d=xs(n,o),l=d.platformSource??N,u=se(r),p=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(p){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(t,e),d.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(d.customTitle,e),d.platformSource){let m=p.platform_source?.trim()?w(p.platform_source):void 0;if(!m)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(d.platformSource,e);else if(m!==d.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${m}, received=${d.platformSource}`)}return p.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,l,u,d.customTitle||null,i.toISOString(),a),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,r){let n=new Date,o=n.getTime(),i=se(r);return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,i,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,r,n,o=0,i,a){let d=i??Date.now(),l=new Date(d).toISOString(),u=te(e,r),p=Z(e,r);if(p!==u){let b=this.db.prepare(`
        SELECT id, created_at_epoch, title, subtitle, facts, narrative, concepts, files_read, files_modified
        FROM observations
        WHERE memory_session_id = ? AND content_hash = ?
      `).get(e,p);if(b&&ee(r,b))return{id:b.id,createdAtEpoch:b.created_at_epoch}}let m=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
       generated_by_model, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, created_at_epoch
    `).get(e,t,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,o,r.agent_type??null,r.agent_id??null,u,l,d,a||null,r.metadata??null);if(m)return{id:m.id,createdAtEpoch:m.created_at_epoch};let f=this.db.prepare("SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?").get(e,u);if(!f)throw new Error(`storeObservation: ON CONFLICT without existing row for content_hash=${u}`);return{id:f.id,createdAtEpoch:f.created_at_epoch}}storeSummary(e,t,r,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,r,n,o,i=0,a,d){let l=a??Date.now(),u=new Date(l).toISOString();return this.db.transaction(()=>{let g=[],m=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),f=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?"),b=this.db.prepare(`
        SELECT id, title, subtitle, facts, narrative, concepts, files_read, files_modified
        FROM observations
        WHERE memory_session_id = ? AND content_hash = ?
      `);for(let T of r){let h=te(e,T),O=Z(e,T);if(O!==h){let L=b.get(e,O);if(L&&ee(T,L)){g.push(L.id);continue}}let U=m.get(e,t,T.type,T.title,T.subtitle,JSON.stringify(T.facts),T.narrative,JSON.stringify(T.concepts),JSON.stringify(T.files_read),JSON.stringify(T.files_modified),o||null,i,T.agent_type??null,T.agent_id??null,h,u,l,d||null);if(U){g.push(U.id);continue}let A=f.get(e,h);if(!A)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${h}`);g.push(A.id)}let S=null;if(n){let h=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,u,l);S=Number(h.lastInsertRowid)}return{observationIds:g,summaryId:S,createdAtEpoch:l}})()}storeObservationsAndMarkComplete(e,t,r,n,o,i,a,d=0,l,u){let p=l??Date.now(),g=new Date(p).toISOString();return this.db.transaction(()=>{let f=[],b=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),S=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?"),T=this.db.prepare(`
        SELECT id, title, subtitle, facts, narrative, concepts, files_read, files_modified
        FROM observations
        WHERE memory_session_id = ? AND content_hash = ?
      `);for(let A of r){let L=te(e,A),He=Z(e,A);if(He!==L){let Ee=T.get(e,He);if(Ee&&ee(A,Ee)){f.push(Ee.id);continue}}let je=b.get(e,t,A.type,A.title,A.subtitle,JSON.stringify(A.facts),A.narrative,JSON.stringify(A.concepts),JSON.stringify(A.files_read),JSON.stringify(A.files_modified),a||null,d,A.agent_type??null,A.agent_id??null,L,g,p,u||null);if(je){f.push(je.id);continue}let Ge=S.get(e,L);if(!Ge)throw new Error(`storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${L}`);f.push(Ge.id)}let h;if(n){let L=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,a||null,d,g,p);h=Number(L.lastInsertRowid)}if(this.db.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND status = 'processing'
      `).run(o).changes!==1)throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${o}`);return{observationIds:f,summaryId:h,createdAtEpoch:p}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o}=t,i=r==="relevance",a=i?"":`ORDER BY created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,d=n?`LIMIT ${n}`:"",l=e.map(()=>"?").join(","),u=[...e],p=o?`WHERE id IN (${l}) AND project = ?`:`WHERE id IN (${l})`;o&&u.push(o);let m=this.db.prepare(`
      SELECT * FROM session_summaries
      ${p}
      ${a}
      ${d}
    `).all(...u);if(!i)return m;let f=new Map(m.map(b=>[b.id,b]));return e.map(b=>f.get(b)).filter(b=>!!b)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o}=t,i=r==="relevance",a=i?"":`ORDER BY up.created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,d=n?`LIMIT ${n}`:"",l=e.map(()=>"?").join(","),u=[...e],p=o?"AND s.project = ?":"";o&&u.push(o);let m=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${l}) ${p}
      ${a}
      ${d}
    `).all(...u);if(!i)return m;let f=new Map(m.map(b=>[b.id,b]));return e.map(b=>f.get(b)).filter(b=>!!b)}getTimelineAroundTimestamp(e,t=10,r=10,n){return this.getTimelineAroundObservation(null,e,t,r,n)}getTimelineAroundObservation(e,t,r=10,n=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,l;if(e!==null){let S=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let h=this.db.prepare(S).all(e,...a,r+1),O=this.db.prepare(T).all(e,...a,n+1);if(h.length===0&&O.length===0)return{observations:[],sessions:[],prompts:[]};d=h.length>0?h[h.length-1].created_at_epoch:t,l=O.length>0?O[O.length-1].created_at_epoch:t}catch(h){return h instanceof Error?_.error("DB","Error getting boundary observations",{project:o},h):_.error("DB","Error getting boundary observations with non-Error",{},new Error(String(h))),{observations:[],sessions:[],prompts:[]}}}else{let S=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let h=this.db.prepare(S).all(t,...a,r),O=this.db.prepare(T).all(t,...a,n+1);if(h.length===0&&O.length===0)return{observations:[],sessions:[],prompts:[]};d=h.length>0?h[h.length-1].created_at_epoch:t,l=O.length>0?O[O.length-1].created_at_epoch:t}catch(h){return h instanceof Error?_.error("DB","Error getting boundary timestamps",{project:o},h):_.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(h))),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,p=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,m=this.db.prepare(u).all(d,l,...a),f=this.db.prepare(p).all(d,l,...a),b=this.db.prepare(g).all(d,l,...a);return{observations:m,sessions:f.map(S=>({id:S.id,memory_session_id:S.memory_session_id,project:S.project,request:S.request,completed:S.completed,next_steps:S.next_steps,created_at:S.created_at,created_at_epoch:S.created_at_epoch})),prompts:b.map(S=>({id:S.id,content_session_id:S.content_session_id,prompt_number:S.prompt_number,prompt_text:S.prompt_text,project:S.project,created_at:S.created_at,created_at_epoch:S.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${t})
      ORDER BY p.created_at_epoch DESC
    `).all(...e)}getSessionSummaryById(e){return this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getOrCreateManualSession(e){let t=`manual-${e}`,r=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,r,e,N,o.toISOString(),o.getTime()),_.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,w(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var D=require("fs"),B=require("path"),Ie=require("os");var Ce={DEFAULT:3e5,HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,WORKER_STARTUP_WAIT:1e3,PRE_RESTART_SETTLE_DELAY:2e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function ct(s){return process.platform==="win32"?Math.round(s*Ce.WINDOWS_MULTIPLIER):s}var ne=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_API_TIMEOUT_MS:String(ct(Ce.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_OBSERVATION_BATCH_SIZE:"5",CLAUDE_MEM_DATA_DIR:(0,B.join)((0,Ie.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,B.join)((0,Ie.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){let t=this.get(e);return t==="true"||t===!0}static applyEnvOverrides(e){let t={...e};for(let r of Object.keys(this.DEFAULTS))process.env[r]!==void 0&&(t[r]=process.env[r]);return t}static loadFromFile(e,t=!0){try{if(!(0,D.existsSync)(e)){let a=this.getAllDefaults();try{let d=(0,B.dirname)(e);(0,D.existsSync)(d)||(0,D.mkdirSync)(d,{recursive:!0}),(0,D.writeFileSync)(e,JSON.stringify(a,null,2),"utf-8"),console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(d){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,d instanceof Error?d.message:String(d))}return t?this.applyEnvOverrides(a):a}let r=(0,D.readFileSync)(e,"utf-8"),n=JSON.parse(r.replace(/^\uFEFF/,"")),o=n;if(n.env&&typeof n.env=="object"){o=n.env;try{(0,D.writeFileSync)(e,JSON.stringify(o,null,2),"utf-8"),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(a){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,a instanceof Error?a.message:String(a))}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(i[a]=o[a]);return t?this.applyEnvOverrides(i):i}catch(r){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,r instanceof Error?r.message:String(r));let n=this.getAllDefaults();return t?this.applyEnvOverrides(n):n}}};var X=require("fs"),oe=require("path");var I=class s{static instance=null;activeMode=null;modesDir;constructor(){let e=qe(),t=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,oe.join)(e,"modes"),(0,oe.join)(e,"..","plugin","modes")],r=t.find(n=>(0,X.existsSync)(n));this.modesDir=r||t[0]}static getInstance(){return s.instance||(s.instance=new s),s.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let r={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?r[n]=this.deepMerge(i,o):r[n]=o}return r}loadModeFile(e){let t=(0,oe.join)(this.modesDir,`${e}.json`);if(!(0,X.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let r=(0,X.readFileSync)(t,"utf-8");return JSON.parse(r)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,_.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(l=>l.id),concepts:d.observation_concepts.map(l=>l.id)}),d}catch(d){if(d instanceof Error?_.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):_.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:r,overrideId:n}=t,o;try{o=this.loadMode(r)}catch(d){d instanceof Error?_.warn("WORKER",`Parent mode '${r}' not found for ${e}, falling back to 'code'`,{message:d.message}):_.warn("WORKER",`Parent mode '${r}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),_.debug("SYSTEM",`Loaded override file: ${n} for parent ${r}`)}catch(d){return d instanceof Error?_.warn("WORKER",`Override file '${n}' not found, using parent mode '${r}' only`,{message:d.message}):_.warn("WORKER",`Override file '${n}' not found, using parent mode '${r}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return _.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${r}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,_.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${r} + ${n})`,void 0,{parent:r,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(r=>r.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(r=>r.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(r=>r.id===e)?.label||e}};function Le(){let s=j.settings(),e=ne.loadFromFile(s),t=I.getInstance().getActiveMode(),r=new Set(t.observation_types.map(o=>o.id)),n=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var c={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},_t=4,Me=1;function De(s){let e=(s.title?.length||0)+(s.subtitle?.length||0)+(s.narrative?.length||0)+JSON.stringify(s.facts||[]).length;return Math.ceil(e/_t)}function ie(s){let e=s.length,t=s.reduce((i,a)=>i+De(a),0),r=s.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=r-t,o=r>0?Math.round(n/r*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:r,savings:n,savingsPercent:o}}function Ps(s){return I.getInstance().getWorkEmoji(s)}function W(s,e){let t=De(s),r=s.discovery_tokens||0,n=Ps(s.type),o=r>0?`${n} ${r.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:r,discoveryDisplay:o,workEmoji:n}}function ae(s){return s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent}var Et=H(require("path"),1),_e=require("fs");var ve=["no durable observation to record","no durable observations to record","no observation to record","no observations to record","no observation to record for batch","no observations to record for batch","no observation to record for this batch","no observations to record for this batch","no observation to record for summary batch","no observations to record for summary batch","no observation to record for this summary batch","no observations to record for this summary batch","nothing durable to record","nothing useful to record","nothing material to record","nothing substantive to record","no substantive tool execution","no substantive tool executions","no substantive tool execution observed","no substantive tool executions observed","no tool usage observed in current session yet"],ws=[/^all routine verification commands\b.*\b(no debugging findings|no root cause analysis to record)\b/i];function C(s){return(s??"").replace(/[\r\n\t]+/g," ").replace(/\s+/g," ").trim()}function k(s){if(Array.isArray(s))return s.map(C).filter(Boolean);let e=C(s);if(!e)return[];if(e.startsWith("["))try{let t=JSON.parse(e);if(Array.isArray(t))return t.filter(r=>typeof r=="string").map(C).filter(Boolean)}catch{}return[e]}function lt(s){let e=C(s.title),t=C(s.subtitle),r=C(s.text),n=C(s.narrative),o=k(s.facts),i=k(s.concepts);if(o.length>0||i.length>0)return!1;let a=[e,t,r,n].filter(Boolean);return a.length===0?!1:a.every(Fs)}function Fs(s){let e=C(s).toLowerCase();return ve.some(t=>e===t||e===`${t}.`)||ws.some(t=>t.test(e))}function pt(s){return lt(s)?!1:!!(C(s.title)||C(s.subtitle)||C(s.text)||C(s.narrative)||k(s.facts).length>0||k(s.concepts).length>0)}function $(s,e=160){if(lt(s))return null;let t=C(s.title);if(t)return F(t,e);let r=C(s.narrative);if(r)return F(ut(r),e);let n=C(s.subtitle);if(n)return F(n,e);let o=C(s.text);if(o)return F(ut(o),e);let i=k(s.facts)[0];if(i)return F(i,e);let a=k(s.concepts);return a.length>0?F(`Concepts: ${a.slice(0,4).join(", ")}`,e):null}function ut(s){return/^(.+?[.!?])(?:\s|$)/.exec(s)?.[1]??s}function F(s,e){return s.length<=e?s:`${s.slice(0,Math.max(0,e-3)).trimEnd()}...`}var ks=ve.flatMap(s=>[s,`${s}.`]),$s=ks.map(s=>`'${s.replace(/'/g,"''")}'`).join(", ");function V(s){return`lower(trim(replace(replace(replace(coalesce(${s}, ''), char(13), ' '), char(10), ' '), char(9), ' ')))`}function de(s){let e=V(s);return`(
    ${e} = ''
    OR ${e} IN (${$s})
    OR (
      ${e} LIKE 'all routine verification commands%'
      AND (
        ${e} LIKE '%no debugging findings%'
        OR ${e} LIKE '%no root cause analysis to record%'
      )
    )
  )`}function ce(s){return`(trim(coalesce(${s}, '[]')) = '' OR trim(coalesce(${s}, '[]')) = '[]')`}function mt(s="o"){let e=`${s}.title`,t=`${s}.subtitle`,r=`${s}.text`,n=`${s}.narrative`,o=`${s}.facts`,i=`${s}.concepts`;return`(
    (
      nullif(trim(coalesce(${e}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${t}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${r}, '')), '') IS NOT NULL
      OR nullif(trim(coalesce(${n}, '')), '') IS NOT NULL
      OR NOT ${ce(o)}
      OR NOT ${ce(i)}
    )
    AND NOT (
      ${ce(o)}
      AND ${ce(i)}
      AND ${de(e)}
      AND ${de(t)}
      AND ${de(r)}
      AND ${de(n)}
      AND (
        ${V(e)} != ''
        OR ${V(t)} != ''
        OR ${V(r)} != ''
        OR ${V(n)} != ''
      )
    )
  )`}var gt=`AND ${mt("o")}`;function ye(s,e,t){let r=Array.from(t.observationTypes),n=r.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(",");return s.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.text,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
      ${gt}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,...r,...o,t.totalObservationCount)}function Ue(s,e,t){return s.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project = ? OR ss.merged_into_project = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,t.sessionCount+Me)}function Tt(s,e,t){let r=Array.from(t.observationTypes),n=r.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return s.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.text,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${a})
           OR o.merged_into_project IN (${a}))
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
      ${gt}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,...r,...o,t.totalObservationCount)}function ft(s,e,t){let r=e.map(()=>"?").join(",");return s.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${r})
           OR ss.merged_into_project IN (${r}))
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,t.sessionCount+Me)}function bt(s){return s.replace(/[/.]/g,"-")}function Hs(s){if(!s.includes('"type":"assistant"'))return null;let e=JSON.parse(s);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let t="";for(let r of e.message.content)r.type==="text"&&(t+=r.text);if(t=t.replace(at,"").trim(),t)return t}return null}function js(s){for(let e=s.length-1;e>=0;e--)try{let t=Hs(s[e]);if(t)return t}catch(t){t instanceof Error?_.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},t):_.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(t)});continue}return""}function Gs(s){try{if(!(0,_e.existsSync)(s))return{userMessage:"",assistantMessage:""};let e=(0,_e.readFileSync)(s,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim());return{userMessage:"",assistantMessage:js(t)}}catch(e){return e instanceof Error?_.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:s},e):_.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:s,error:String(e)}),{userMessage:"",assistantMessage:""}}}function xe(s,e,t,r){if(!e.showLastMessage||s.length===0)return{userMessage:"",assistantMessage:""};let n=s.find(d=>d.memory_session_id!==t);if(!n)return{userMessage:"",assistantMessage:""};let o=n.memory_session_id,i=bt(r),a=Et.default.join(P,"projects",i,`${o}.jsonl`);return Gs(a)}function St(s,e){let t=e[0]?.id;return s.map((r,n)=>{let o=n===0?null:e[n+1];return{...r,displayEpoch:o?o.created_at_epoch:r.created_at_epoch,displayTime:o?o.created_at:r.created_at,shouldShowLink:r.id!==t}})}function Pe(s,e){let t=[...s.map(r=>({type:"observation",data:r})),...e.map(r=>({type:"summary",data:r}))];return t.sort((r,n)=>{let o=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function ht(s,e){return new Set(s.slice(0,e).map(t=>t.id))}function Ot(){let s=new Date,e=s.toLocaleDateString("en-CA"),t=s.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),r=s.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${r}`}function Rt(s){return[`# [${s}] recent context, ${Ot()}`,""]}function At(){return[`Legend: \u{1F3AF}session ${I.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji}${t.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function Nt(){return[]}function Ct(){return[]}function It(s,e){let t=[],r=[`${s.totalObservations} obs (${s.totalReadTokens.toLocaleString()}t read)`,`${s.totalDiscoveryTokens.toLocaleString()}t work`];return s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?r.push(`${s.savingsPercent}% savings`):e.showSavingsAmount&&r.push(`${s.savings.toLocaleString()}t saved`)),t.push(`Stats: ${r.join(" | ")}`),t.push(""),t}function Lt(s){return[`### ${s}`]}function Mt(s){return s.toLowerCase().replace(" am","a").replace(" pm","p")}function Dt(s,e,t){let r=$(s)??"Observation",n=I.getInstance().getTypeIcon(s.type),o=e?Mt(e):'"';return`${s.id} ${o} ${n} ${r}`}function vt(s,e,t,r){let n=[],o=$(s)??"Observation",i=I.getInstance().getTypeIcon(s.type),a=e?Mt(e):'"',{readTokens:d,discoveryDisplay:l}=W(s,r);n.push(`**${s.id}** ${a} ${i} **${o}**`),t&&n.push(t);let u=[];return r.showReadTokens&&u.push(`~${d}t`),r.showWorkTokens&&u.push(l),u.length>0&&n.push(u.join(" ")),n.push(""),n}function yt(s,e){return[`S${s.id} ${s.request||"Session started"} (${e})`]}function Y(s,e){return e?[`**${s}**: ${e}`,""]:[]}function Ut(s){return s.assistantMessage?["","---","","**Previously**","",`A: ${s.assistantMessage}`,""]:[]}function xt(s,e){return["",`Access ${Math.round(s/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Pt(s){return`# [${s}] recent context, ${Ot()}

No previous sessions found.`}function wt(){let s=new Date,e=s.toLocaleDateString("en-CA"),t=s.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),r=s.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${r}`}function Ft(s){return["",`${c.bright}${c.cyan}[${s}] recent context, ${wt()}${c.reset}`,`${c.gray}${"\u2500".repeat(60)}${c.reset}`,""]}function kt(){let e=I.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${c.dim}Legend: session-request | ${e}${c.reset}`,""]}function $t(){return[`${c.bright}Column Key${c.reset}`,`${c.dim}  Read: Tokens to read this observation (cost to learn it now)${c.reset}`,`${c.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${c.reset}`,""]}function Ht(){return[`${c.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${c.reset}`,"",`${c.dim}When you need implementation details, rationale, or debugging context:${c.reset}`,`${c.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${c.reset}`,`${c.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${c.reset}`,`${c.dim}  - Trust this index over re-reading code for past decisions and learnings${c.reset}`,""]}function jt(s,e){let t=[];if(t.push(`${c.bright}${c.cyan}Context Economics${c.reset}`),t.push(`${c.dim}  Loading: ${s.totalObservations} observations (${s.totalReadTokens.toLocaleString()} tokens to read)${c.reset}`),t.push(`${c.dim}  Work investment: ${s.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${c.reset}`),s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let r="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?r+=`${s.savings.toLocaleString()} tokens (${s.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?r+=`${s.savings.toLocaleString()} tokens`:r+=`${s.savingsPercent}% reduction from reuse`,t.push(`${c.green}${r}${c.reset}`)}return t.push(""),t}function Gt(s){return[`${c.bright}${c.cyan}${s}${c.reset}`,""]}function Bt(s){return[`${c.dim}${s}${c.reset}`]}function Xt(s,e,t,r){let n=$(s)??"Observation",o=I.getInstance().getTypeIcon(s.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=W(s,r),l=t?`${c.dim}${e}${c.reset}`:" ".repeat(e.length),u=r.showReadTokens&&i>0?`${c.dim}(~${i}t)${c.reset}`:"",p=r.showWorkTokens&&a>0?`${c.dim}(${d} ${a.toLocaleString()}t)${c.reset}`:"";return`  ${c.dim}#${s.id}${c.reset}  ${l}  ${o}  ${n} ${u} ${p}`}function Wt(s,e,t,r,n){let o=[],i=$(s)??"Observation",a=I.getInstance().getTypeIcon(s.type),{readTokens:d,discoveryTokens:l,workEmoji:u}=W(s,n),p=t?`${c.dim}${e}${c.reset}`:" ".repeat(e.length),g=n.showReadTokens&&d>0?`${c.dim}(~${d}t)${c.reset}`:"",m=n.showWorkTokens&&l>0?`${c.dim}(${u} ${l.toLocaleString()}t)${c.reset}`:"";return o.push(`  ${c.dim}#${s.id}${c.reset}  ${p}  ${a}  ${c.bright}${i}${c.reset}`),r&&o.push(`    ${c.dim}${r}${c.reset}`),(g||m)&&o.push(`    ${g} ${m}`),o.push(""),o}function Vt(s,e){let t=`${s.request||"Session started"} (${e})`;return[`${c.yellow}#S${s.id}${c.reset} ${t}`,""]}function K(s,e,t){return e?[`${t}${s}:${c.reset} ${e}`,""]:[]}function Yt(s){return s.assistantMessage?["","---","",`${c.bright}${c.magenta}Previously${c.reset}`,"",`${c.dim}A: ${s.assistantMessage}${c.reset}`,""]:[]}function Kt(s,e){let t=Math.round(s/1e3);return["",`${c.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${c.reset}`]}function qt(s){return`
${c.bright}${c.cyan}[${s}] recent context, ${wt()}${c.reset}
${c.gray}${"\u2500".repeat(60)}${c.reset}

${c.dim}No previous sessions found for this project yet.${c.reset}
`}function Jt(s,e,t,r){let n=[];return r?n.push(...Ft(s)):n.push(...Rt(s)),r?n.push(...kt()):n.push(...At()),r?n.push(...$t()):n.push(...Nt()),r?n.push(...Ht()):n.push(...Ct()),ae(t)&&(r?n.push(...jt(e,t)):n.push(...It(e,t))),n}var we=H(require("path"),1);function pe(s){if(!s)return[];try{let e=JSON.parse(s);return Array.isArray(e)?e:[]}catch(e){return _.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:s?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Fe(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ke(s){return new Date(s).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function zt(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Qt(s,e){return we.default.isAbsolute(s)?we.default.relative(e,s):s}function Zt(s,e,t){let r=pe(s);if(r.length>0)return Qt(r[0],e);if(t){let n=pe(t);if(n.length>0)return Qt(n[0],e)}return"General"}function Bs(s){let e=new Map;for(let r of s){let n=r.type==="observation"?r.data.created_at:r.data.displayTime,o=zt(n);e.has(o)||e.set(o,[]),e.get(o).push(r)}let t=Array.from(e.entries()).sort((r,n)=>{let o=new Date(r[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function es(s,e){return e.fullObservationField==="narrative"?s.narrative:s.facts?pe(s.facts).join(`
`):null}function Xs(s,e,t,r){let n=[];n.push(...Lt(s));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Fe(a.displayTime);n.push(...yt(a,d))}else{let a=i.data,d=ke(a.created_at),u=d!==o?d:"";if(o=d,t.has(a.id)){let g=es(a,r);n.push(...vt(a,u,g,r))}else n.push(Dt(a,u,r))}return n}function Ws(s,e,t,r,n){let o=[];o.push(...Gt(s));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let l=d.data,u=Fe(l.displayTime);o.push(...Vt(l,u))}else{let l=d.data,u=Zt(l.files_modified,n,l.files_read),p=ke(l.created_at),g=p!==a;a=p;let m=t.has(l.id);if(u!==i&&(o.push(...Bt(u)),i=u),m){let f=es(l,r);o.push(...Wt(l,p,g,f,r))}else o.push(Xt(l,p,g,r))}return o.push(""),o}function Vs(s,e,t,r,n,o){return o?Ws(s,e,t,r,n):Xs(s,e,t,r)}function ts(s,e,t,r,n){let o=[],i=Bs(s);for(let[a,d]of i)o.push(...Vs(a,d,e,t,r,n));return o}function ss(s,e,t){return!(!s.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function rs(s,e){let t=[];return e?(t.push(...K("Investigated",s.investigated,c.blue)),t.push(...K("Learned",s.learned,c.yellow)),t.push(...K("Completed",s.completed,c.green)),t.push(...K("Next Steps",s.next_steps,c.magenta))):(t.push(...Y("Investigated",s.investigated)),t.push(...Y("Learned",s.learned)),t.push(...Y("Completed",s.completed)),t.push(...Y("Next Steps",s.next_steps))),t}function ns(s,e){return e?Yt(s):Ut(s)}function os(s,e,t){return!ae(e)||s.totalDiscoveryTokens<=0||s.savings<=0?[]:t?Kt(s.totalDiscoveryTokens,s.totalReadTokens):xt(s.totalDiscoveryTokens,s.totalReadTokens)}var Ys=is.default.join((0,as.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ks(){try{return new re}catch(s){if(s instanceof Error&&s.code==="ERR_DLOPEN_FAILED"){try{(0,ds.unlinkSync)(Ys)}catch(e){e instanceof Error?_.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):_.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return _.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw s}}function qs(s,e){return e?qt(s):Pt(s)}function Js(s,e,t,r,n,o,i){let a=[],d=ie(e);a.push(...Jt(s,d,r,i));let l=t.slice(0,r.sessionCount),u=St(l,t),p=Pe(e,u),g=ht(e,r.fullObservationCount);a.push(...ts(p,g,r,n,i));let m=t[0],f=e[0];ss(r,m,f)&&a.push(...rs(m,i));let b=xe(e,r,o,n);return a.push(...ns(b,i)),a.push(...os(d,r,i)),a.join(`
`).trimEnd()}var Qs=new Set(["bugfix","discovery","decision","refactor"]);function zs(s,e,t){let r=ie(s),n={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let d of s){let l=Qs.has(d.type)?d.type:"other";n[l]++,d.memory_session_id&&o.add(d.memory_session_id),d.created_at_epoch&&d.created_at_epoch<i&&(i=d.created_at_epoch)}let a=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:s.length,session_count:o.size,timeline_depth_days:a,has_session_summary:e.length>0,obs_type_bugfix:n.bugfix,obs_type_discovery:n.discovery,obs_type_decision:n.decision,obs_type_refactor:n.refactor,obs_type_other:n.other,tokens_injected:r.totalReadTokens,tokens_saved_vs_naive:r.savings,search_strategy:t?"full":"timeline"}}async function me(s,e=!1){let t=Le(),r=s?.cwd??process.cwd(),n=he(r),o=s?.projects?.length?s.projects:n.allProjects,i=o[o.length-1]??n.primary;s?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=Ks();if(!a)return{text:"",stats:null};try{let d={...t,totalObservationCount:t.totalObservationCount>=999999?t.totalObservationCount:Math.max(t.totalObservationCount,Math.min(t.totalObservationCount*4,t.totalObservationCount+200))},u=(o.length>1?Tt(a,o,d):ye(a,i,d)).filter(m=>pt(m)).slice(0,t.totalObservationCount),p=o.length>1?ft(a,o,t):Ue(a,i,t);return u.length===0&&p.length===0?{text:qs(i,e),stats:null}:{text:Js(i,u,p,t,r,s?.session_id,e),stats:zs(u,p,!!s?.full)}}finally{a.close()}}async function $e(s,e=!1){return(await me(s,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
