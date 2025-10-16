#!/usr/bin/env bun
// @bun
import U from"net";import{Database as O}from"bun:sqlite";import{join as Y,dirname as b,basename as E}from"path";import{homedir as M}from"os";import{existsSync as C,mkdirSync as N}from"fs";var $=process.env.CLAUDE_MEM_DATA_DIR||Y(M(),".claude-mem"),V=process.env.CLAUDE_CONFIG_DIR||Y(M(),".claude"),P=Y($,"archives"),k=Y($,"logs"),l=Y($,"trash"),S=Y($,"backups"),y=Y($,"chroma"),h=Y($,"settings.json"),q=Y($,"claude-mem.db"),R=Y(V,"settings.json"),j=Y(V,"commands"),A=Y(V,"CLAUDE.md");function F(z){return Y($,`worker-${z}.sock`)}function G(z){N(z,{recursive:!0})}class v{db;constructor(){G($),this.db=new O(q,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,X=10){return this.db.query(`
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
    `).get(z)||null}createSDKSession(z,X,Q){let Z=new Date,K=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,X,Q,Z.toISOString(),K),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,X){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(X,z)}storeObservation(z,X,Q,Z){let K=new Date,B=K.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,X,Z,Q,K.toISOString(),B)}storeSummary(z,X,Q){let Z=new Date,K=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,X,Q.request||null,Q.investigated||null,Q.learned||null,Q.completed||null,Q.next_steps||null,Q.files_read||null,Q.files_edited||null,Q.notes||null,Z.toISOString(),K)}markSessionCompleted(z){let X=new Date,Q=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Q,z)}markSessionFailed(z){let X=new Date,Q=X.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(X.toISOString(),Q,z)}close(){this.db.close()}}function x(z){try{if(!z)console.log("No input provided - this script is designed to run as a Claude Code Stop hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string"},null,2)),process.exit(0);let{session_id:X}=z,Q=new v,Z=Q.findActiveSDKSession(X);if(Q.close(),!Z)console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);let K=F(Z.id),B={type:"finalize"},W=U.connect(K,()=>{W.write(JSON.stringify(B)+`
`),W.end()});W.on("error",(J)=>{console.error(`[claude-mem summary] Socket error: ${J.message}`)}),W.on("close",()=>{console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)})}catch(X){console.error(`[claude-mem summary error: ${X.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}var L=await Bun.stdin.text();try{let z=L.trim()?JSON.parse(L):void 0;x(z)}catch(z){console.error(`[claude-mem summary-hook error: ${z.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
