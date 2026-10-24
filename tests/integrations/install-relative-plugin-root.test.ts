import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getMcpServerAbsolutePath, getWorkerServiceAbsolutePath } from '../../src/services/integrations/install-paths.js';
import { mcpMemberItem, nodeMcpServerEntry } from '../../src/services/wire-gateway/library/agent-library-targets.js';
import { applyLibraryForInstaller, currentLibraryInstallEnvironment } from '../../src/services/wire-gateway/library/library-runtime.js';
const cwd = process.cwd(); const prior = process.env.CLAUDE_PLUGIN_ROOT;
let root: string;
afterEach(() => {process.chdir(cwd); if(prior===undefined)delete process.env.CLAUDE_PLUGIN_ROOT;else process.env.CLAUDE_PLUGIN_ROOT=prior; if(root)rmSync(root,{recursive:true,force:true});});
describe('installer absolute plugin paths',()=>{
  it('bakes a relative configured root into an MCP config that launches from another directory',()=>{
    root=mkdtempSync(join(tmpdir(),'cm-relative-root-'));mkdirSync(join(root,'owned-plugin','scripts'),{recursive:true});mkdirSync(join(root,'host-cwd'));
    writeFileSync(join(root,'owned-plugin','scripts','mcp-server.cjs'),'process.stdout.write("OWNED MCP RUNNING");');
    writeFileSync(join(root,'owned-plugin','scripts','worker-service.cjs'),'');
    process.chdir(root);process.env.CLAUDE_PLUGIN_ROOT='./owned-plugin';
    const serverPath=getMcpServerAbsolutePath(); const workerPath=getWorkerServiceAbsolutePath();
    const config=join(root,'owned-config.json');
    applyLibraryForInstaller({agentId:'relative-root-test',items:[mcpMemberItem(config,['mcpServers','claude-mem'],nodeMcpServerEntry({...currentLibraryInstallEnvironment(),mcpServerPath:serverPath}))],ownedGroups:['mcp']});
    const entry=JSON.parse(readFileSync(config,'utf8')).mcpServers['claude-mem'];
    const launched=spawnSync(entry.command,entry.args,{cwd:join(root,'host-cwd'),encoding:'utf8'});
    expect(launched.status).toBe(0);expect(launched.stdout).toBe('OWNED MCP RUNNING');
    expect(isAbsolute(serverPath!)).toBe(true);expect(isAbsolute(workerPath!)).toBe(true);
  });
});
