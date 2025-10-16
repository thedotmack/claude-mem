#!/usr/bin/env bun
// @bun
import b from"net";import{Database as O}from"bun:sqlite";import{join as Y,dirname as w,basename as C}from"path";import{homedir as F}from"os";import{existsSync as S,mkdirSync as H}from"fs";var $=process.env.CLAUDE_MEM_DATA_DIR||Y(F(),".claude-mem"),J=process.env.CLAUDE_CONFIG_DIR||Y(F(),".claude"),h=Y($,"archives"),l=Y($,"logs"),R=Y($,"trash"),j=Y($,"backups"),A=Y($,"chroma"),I=Y($,"settings.json"),G=Y($,"claude-mem.db"),_=Y(J,"settings.json"),p=Y(J,"commands"),d=Y(J,"CLAUDE.md");function v(z){return Y($,`worker-${z}.sock`)}function x(z){H(z,{recursive:!0})}class M{db;constructor(){x($),this.db=new O(G,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,X=10){return this.db.query(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(z,X)}findActiveSDKSession(z){return this.db.query(`
      SELECT id, sdk_session_id, project
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(z)||null}createSDKSession(z,X,Q){let Z=new Date,W=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,X,Q,Z.toISOString(),W),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,X){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(X,z)}storeObservation(z,X,Q,Z){let W=new Date,B=W.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,X,Z,Q,W.toISOString(),B)}storeSummary(z,X,Q){let Z=new Date,W=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,X,Q.request||null,Q.investigated||null,Q.learned||null,Q.completed||null,Q.next_steps||null,Q.files_read||null,Q.files_edited||null,Q.notes||null,Z.toISOString(),W)}markSessionCompleted(z){let X=new Date,Q=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Q,z)}markSessionFailed(z){let X=new Date,Q=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Q,z)}close(){this.db.close()}}var E=new Set(["TodoWrite","ListMcpResourcesTool"]);function N(z){try{if(!z)console.log("No input provided - this script is designed to run as a Claude Code PostToolUse hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string",tool_name:"string",tool_input:{},tool_output:{}},null,2)),process.exit(0);let{session_id:X,tool_name:Q,tool_input:Z,tool_output:W}=z;if(E.has(Q))console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);let B=new M,K=B.findActiveSDKSession(X);if(B.close(),!K)console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);let q=v(K.id),U={type:"observation",tool_name:Q,tool_input:JSON.stringify(Z),tool_output:JSON.stringify(W)},V=b.connect(q,()=>{V.write(JSON.stringify(U)+`
`),V.end()});V.on("error",(f)=>{console.error(`[claude-mem save] Socket error: ${f.message}`)}),V.on("close",()=>{console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)})}catch(X){console.error(`[claude-mem save error: ${X.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}var L=await Bun.stdin.text();try{let z=L.trim()?JSON.parse(L):void 0;N(z)}catch(z){console.error(`[claude-mem save-hook error: ${z.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
