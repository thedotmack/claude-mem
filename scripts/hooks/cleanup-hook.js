#!/usr/bin/env bun
// @bun
import{existsSync as O,unlinkSync as U}from"fs";import{Database as N}from"bun:sqlite";import{join as $,dirname as b,basename as g}from"path";import{homedir as J}from"os";import{existsSync as P,mkdirSync as L}from"fs";var W=process.env.CLAUDE_MEM_DATA_DIR||$(J(),".claude-mem"),V=process.env.CLAUDE_CONFIG_DIR||$(J(),".claude"),y=$(W,"archives"),S=$(W,"logs"),l=$(W,"trash"),R=$(W,"backups"),k=$(W,"chroma"),j=$(W,"settings.json"),M=$(W,"claude-mem.db"),A=$(V,"settings.json"),h=$(V,"commands"),I=$(V,"CLAUDE.md");function q(z){return $(W,`worker-${z}.sock`)}function F(z){L(z,{recursive:!0})}class v{db;constructor(){F(W),this.db=new N(M,{create:!0,readwrite:!0}),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON")}getRecentSummaries(z,Q=10){return this.db.query(`
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
    `).get(z)||null}createSDKSession(z,Q,X){let Z=new Date,Y=Z.getTime();return this.db.query(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(z,Q,X,Z.toISOString(),Y),this.db.query("SELECT last_insert_rowid() as id").get().id}updateSDKSessionId(z,Q){this.db.query(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(Q,z)}storeObservation(z,Q,X,Z){let Y=new Date,K=Y.getTime();this.db.query(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(z,Q,Z,X,Y.toISOString(),K)}storeSummary(z,Q,X){let Z=new Date,Y=Z.getTime();this.db.query(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(z,Q,X.request||null,X.investigated||null,X.learned||null,X.completed||null,X.next_steps||null,X.files_read||null,X.files_edited||null,X.notes||null,Z.toISOString(),Y)}markSessionCompleted(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}markSessionFailed(z){let Q=new Date,X=Q.getTime();this.db.query(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(Q.toISOString(),X,z)}close(){this.db.close()}}function G(z){try{if(console.error("[claude-mem cleanup] Hook fired",{input:z?{session_id:z.session_id,cwd:z.cwd,reason:z.reason}:null}),!z)console.log("No input provided - this script is designed to run as a Claude Code SessionEnd hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string",transcript_path:"string",hook_event_name:"SessionEnd",reason:"exit"},null,2)),process.exit(0);let{session_id:Q,reason:X}=z;console.error("[claude-mem cleanup] Searching for active SDK session",{session_id:Q,reason:X});let Z=new v,Y=Z.findActiveSDKSession(Q);if(!Y)console.error("[claude-mem cleanup] No active SDK session found",{session_id:Q}),Z.close(),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0);console.error("[claude-mem cleanup] Active SDK session found",{session_id:Y.id,sdk_session_id:Y.sdk_session_id,project:Y.project});let K=q(Y.id);try{if(O(K)){console.error("[claude-mem cleanup] Socket file exists, attempting cleanup",{socketPath:K});try{U(K),console.error("[claude-mem cleanup] Socket file removed successfully",{socketPath:K})}catch(B){console.error("[claude-mem cleanup] Failed to remove socket file",{error:B.message,socketPath:K})}}else console.error("[claude-mem cleanup] Socket file does not exist",{socketPath:K})}catch(B){console.error("[claude-mem cleanup] Error during cleanup",{error:B.message,stack:B.stack})}try{Z.markSessionFailed(Y.id),console.error("[claude-mem cleanup] Session marked as failed",{session_id:Y.id,reason:"SessionEnd hook - session terminated without completion"})}catch(B){console.error("[claude-mem cleanup] Failed to mark session as failed",{error:B.message,session_id:Y.id})}Z.close(),console.error("[claude-mem cleanup] Cleanup completed successfully"),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}catch(Q){console.error("[claude-mem cleanup] Unexpected error in hook",{error:Q.message,stack:Q.stack,name:Q.name}),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}var x=await Bun.stdin.text();try{let z=x.trim()?JSON.parse(x):void 0;G(z)}catch(z){console.error(`[claude-mem cleanup-hook error: ${z.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}
