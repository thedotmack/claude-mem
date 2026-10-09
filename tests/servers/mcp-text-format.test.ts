import { describe, expect, it } from 'bun:test';
import { formatMcpPayload, formatWorkerMcpResponse, mcpTextResult, workerFailureText } from '../../src/servers/mcp-text-format.js';

describe('purpose-specific model responses', () => {
  it('confirms note writes without echoing the stored note or internal metadata', () => {
    const result = formatMcpPayload('save', { success: true, id: 42, title: 'A durable lesson', project: 'p', text: 'PRIVATE_NOTE_BODY', metadata: { secret: 'PRIVATE_METADATA' } });
    expect(result.content[0].text).toBe('Saved memory #42: A durable lesson. Project: p.');
    expect(result).not.toHaveProperty('structuredContent');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(formatMcpPayload('save', { duplicate: true, id: 42 }).content[0].text).toContain('already saved');
  });
  it('returns only a title index for a search, then curated details for explicitly selected rows', () => {
    const row = { id: 8, title: 'Auth redirect decision', project: 'p', narrative: 'SELECTED_NARRATIVE', facts: '["A useful fact"]', metadata: 'PRIVATE_METADATA', sdk_session_id: 'PRIVATE_SESSION', token_usage: 91234 };
    const index = formatMcpPayload('search', { observations: [row] });
    expect(index.content[0].text).toContain('#8 — Auth redirect decision');
    expect(JSON.stringify(index)).not.toContain('SELECTED_NARRATIVE');
    const untitled = formatMcpPayload('search', { observations: [{ id: 9, content: '{"narrative":"PRIVATE_INDEX_BODY","metadata":"PRIVATE_INDEX_METADATA"}' }] });
    expect(untitled.content[0].text).toContain('Untitled memory');
    expect(JSON.stringify(untitled)).not.toContain('PRIVATE_INDEX_');
    const details = formatMcpPayload('observations', [row]);
    expect(details.content[0].text).toContain('SELECTED_NARRATIVE');
    expect(details.content[0].text).toContain('- A useful fact');
    expect(JSON.stringify(details)).not.toContain('PRIVATE_');
    expect(JSON.stringify(details)).not.toContain('91234');
  });
  it('supports server content and returns a single context rendering', () => {
    expect(formatMcpPayload('observations', [{ id: 'uuid', projectId: 'p', content: 'A useful server lesson', metadata: { secret: 'PRIVATE_METADATA' } }]).content[0].text).toContain('A useful server lesson');
    const context = formatMcpPayload('context', { context: 'CURATED_CONTEXT', observations: [{ content: 'DUPLICATED_BODY' }] });
    expect(context.content[0].text).toContain('CURATED_CONTEXT');
    expect(JSON.stringify(context)).not.toContain('DUPLICATED_BODY');
  });
  it('discloses selected tool I/O as a bounded readable tree without database columns', () => {
    const result = formatMcpPayload('tool-uses', [{ id: 1, tool_name: 'Read', tool_input: '{"file_path":"src/app.ts"}', tool_response: '{"content":"selected file"}', memory_session_id: 'PRIVATE_SESSION' }]);
    expect(result.content[0].text).toContain('Input:\nfile_path: src/app.ts');
    expect(result.content[0].text).toContain('Response:\ncontent: selected file');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SESSION');
  });
  it('selects corpus state and answers without model prompts or session payloads', () => {
    const corpus = { name: 'auth', description: 'Auth knowledge', stats: { observation_count: 12, token_estimate: 340 }, session_id: null, system_prompt: 'PRIVATE_PROMPT', observations: [{ narrative: 'PRIVATE_CORPUS_BODY' }] };
    expect(formatMcpPayload('corpus-build', corpus).content[0].text).toContain('12 observations; 340 estimated tokens; not primed');
    const list = formatWorkerMcpResponse('corpus-list', { content: [{ type: 'text', text: JSON.stringify([corpus]) }], structuredContent: corpus });
    expect(list.content[0].text).toContain('Knowledge corpora');
    expect(JSON.stringify(list)).not.toContain('PRIVATE_');
    expect(list).not.toHaveProperty('structuredContent');
    expect(formatMcpPayload('corpus-query', { answer: 'Selected answer', session_id: 'PRIVATE_SESSION' }).content[0].text).toBe('Corpus answer:\n\nSelected answer');
  });
  it('preserves operation receipts, actionable error advice, and valid bounded UTF-8', () => {
    expect(formatMcpPayload('event', { event: { id: 'e' }, generationJob: { id: 'j', status: 'queued', payload: 'PRIVATE_PAYLOAD' } }).content[0].text).toBe('Recorded event #e. Generation job j: queued.');
    expect(formatMcpPayload('job', { generationJob: { id: 'j', status: 'failed', payload: 'PRIVATE_PAYLOAD' } }).content[0].text).toBe('Generation job j: failed.');
    const error = workerFailureText('Worker API error (409): {"error":"Rebuild would shrink corpus","fix":"Previous corpus kept","filter":{"secret":"PRIVATE_FILTER"}}');
    expect(error).toContain('Previous corpus kept');
    expect(error).not.toContain('PRIVATE_FILTER');
    const text = mcpTextResult('😀'.repeat(40_000)).content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(text).not.toContain('\ufffd');
    expect(text).toContain('Response shortened');
  });
  it('never passes an accidental JSON text envelope or duplicate structured content through', () => {
    const result = formatWorkerMcpResponse('save', { content: [{ type: 'text', text: '{"id":42,"title":"Receipt","metadata":"PRIVATE_METADATA"}' }], structuredContent: { metadata: 'PRIVATE_METADATA' } });
    expect(result.content[0].text).toStartWith('Saved memory #42');
    expect(() => JSON.parse(result.content[0].text)).toThrow();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_METADATA');
    expect(formatWorkerMcpResponse('search', { content: [{ type: 'text', text: 'Existing readable Markdown' }] }).content[0].text).toBe('Existing readable Markdown');
  });
});
