#!/usr/bin/env bun
// @bun
import{Database as f}from"bun:sqlite";import{join as X,dirname as g,basename as C}from"path";import{homedir as q}from"os";import{existsSync as S,mkdirSync as U}from"fs";var Z=process.env.CLAUDE_MEM_DATA_DIR||X(q(),".claude-mem"),B=process.env.CLAUDE_CONFIG_DIR||X(q(),".claude"),l=X(Z,"archives"),y=X(Z,"logs"),h=X(Z,"trash"),j=X(Z,"backups"),A=X(Z,"chroma"),R=X(Z,"settings.json"),F=X(Z,"claude-mem.db"),_=X(B,"settings.json"),I=X(B,"commands"),c=X(B,"CLAUDE.md");function G(z){U(z,{recursive:!0})}class V{db;constructor(){G(Z),this.db=new f(F,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,Q=10){return this.db.query(`
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
    `).get(z)||null}createSDKSession(z,Q,W){let Y=new Date,$=Y.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,Q,W,Y.toISOString(),$),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,Q){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Q,z)}storeObservation(z,Q,W,Y){let $=new Date,K=$.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,Q,Y,W,$.toISOString(),K)}storeSummary(z,Q,W){let Y=new Date,$=Y.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,Q,W.request||null,W.investigated||null,W.learned||null,W.completed||null,W.next_steps||null,W.files_read||null,W.files_edited||null,W.notes||null,Y.toISOString(),$)}markSessionCompleted(z){let Q=new Date,W=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),W,z)}markSessionFailed(z){let Q=new Date,W=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),W,z)}close(){this.db.close()}}import x from"path";import{spawn as H}from"child_process";function L(z){try{if(!z)console.log("No input provided - this script is designed to run as a Claude Code UserPromptSubmit hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string",prompt:"string"},null,2)),process.exit(0);let{session_id:Q,cwd:W,prompt:Y}=z,$=x.basename(W),K=new V;if(K.findActiveSDKSession(Q))K.close(),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);let J=K.createSDKSession(Q,$,Y);K.close();let M=process.env.CLAUDE_PLUGIN_ROOT;if(!M)throw new Error("CLAUDE_PLUGIN_ROOT not set - claude-mem must be installed as a Claude Code plugin");let N=x.join(M,"scripts","hooks","worker.js");H("bun",[N,J.toString()],{detached:!0,stdio:"ignore"}).unref(),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}catch(Q){console.error(`[claude-mem new error: ${Q.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}var O=await Bun.stdin.text();try{let z=O.trim()?JSON.parse(O):void 0;L(z)}catch(z){console.error(`[claude-mem new-hook error: ${z.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
