#!/usr/bin/env bun
// @bun
import U from"net";import{Database as O}from"bun:sqlite";import{join as Z,dirname as b,basename as E}from"path";import{homedir as M}from"os";import{existsSync as C,mkdirSync as N}from"fs";var K=process.env.CLAUDE_MEM_DATA_DIR||Z(M(),".claude-mem"),v=process.env.CLAUDE_CONFIG_DIR||Z(M(),".claude"),P=Z(K,"archives"),l=Z(K,"logs"),S=Z(K,"trash"),k=Z(K,"backups"),y=Z(K,"chroma"),h=Z(K,"settings.json"),q=Z(K,"claude-mem.db"),R=Z(v,"settings.json"),j=Z(v,"commands"),A=Z(v,"CLAUDE.md");function F(z){return Z(K,`worker-${z}.sock`)}function G(z){N(z,{recursive:!0})}class J{db;constructor(){G(K),this.db=new O(q,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,Q=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,Q)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,Q,X){let Y=new Date,$=Y.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,Q,X,Y.toISOString(),$),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,Q){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Q,z)}storeObservation(z,Q,X,Y){let $=new Date,W=$.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,Q,Y,X,$.toISOString(),W)}storeSummary(z,Q,X){let Y=new Date,$=Y.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,Q,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,Y.toISOString(),$)}markSessionCompleted(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}markSessionFailed(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}close(){this.db.close()}}function x(z){try{if(console.error("[claude-mem summary] Hook fired",{input:z?{session_id:z.session_id,cwd:z.cwd}:null}),!z)console.log("No input provided - this script is designed to run as a Claude Code Stop hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string"},null,2)),process.exit(0);let{session_id:Q}=z;console.error("[claude-mem summary] Searching for active SDK session",{session_id:Q});let X=new J,Y=X.findActiveSDKSession(Q);if(X.close(),!Y)console.error("[claude-mem summary] No active SDK session found",{session_id:Q}),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);console.error("[claude-mem summary] Active SDK session found",{session_id:Y.id,collection_name:Y.collection_name,worker_pid:Y.worker_pid});let $=F(Y.id),W={type:"finalize"};console.error("[claude-mem summary] Attempting to send FINALIZE message to worker socket",{socketPath:$,message:W});let B=U.connect($,()=>{console.error("[claude-mem summary] Socket connection established, sending message"),B.write(JSON.stringify(W)+`
`),B.end()});B.on("error",(V)=>{console.error("[claude-mem summary] Socket error occurred",{error:V.message,code:V.code,socketPath:$})}),B.on("close",()=>{console.error("[claude-mem summary] Socket connection closed successfully"),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)})}catch(Q){console.error("[claude-mem summary] Unexpected error in hook",{error:Q.message,stack:Q.stack,name:Q.name}),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}var L=await Bun.stdin.text();try{let z=L.trim()?JSON.parse(L):void 0;x(z)}catch(z){console.error(`[claude-mem summary-hook error: ${z.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
