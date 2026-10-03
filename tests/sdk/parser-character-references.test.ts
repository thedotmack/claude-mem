import { beforeEach, describe, expect, it } from 'bun:test';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../src/services/sqlite/observations/get.js';

beforeEach(() => ModeManager.getInstance().loadMode('code'));
function observation(raw: string) {
  const result = parseAgentXml(raw);
  if (!result.valid || result.observations.length !== 1) throw new Error('Expected one observation');
  return result.observations[0];
}

describe('XML character references at the observer boundary', () => {
  it('decodes field and array values after extracting the XML markup', () => {
    const result = observation(`<observation><type>discovery</type>
      <title>Quotes &quot;double&quot; and &apos;single&apos;</title>
      <subtitle>A &amp; B</subtitle><narrative>x &lt; y &gt; z</narrative>
      <facts><fact>Literal &amp;lt;tag&amp;gt;</fact></facts>
      <files_read><file>src/A&amp;B.ts</file></files_read>
      <files_modified><file>src/&#x65E5;&#26412;.ts</file></files_modified>
    </observation>`);
    expect(result.title).toBe('Quotes "double" and \'single\'');
    expect(result.subtitle).toBe('A & B'); expect(result.narrative).toBe('x < y > z');
    expect(result.facts).toEqual(['Literal &lt;tag&gt;']);
    expect(result.files_read).toEqual(['src/A&B.ts']); expect(result.files_modified).toEqual(['src/日本.ts']);
  });
  it('restores the real file name used by native file context lookup', () => {
    const store = new SessionStore(':memory:');
    try {
      const sid = store.createSDKSession('content', 'project', 'prompt');
      store.ensureMemorySessionIdRegistered(sid, 'memory');
      const parsed = observation('<observation><type>discovery</type><title>A &amp; B</title><files_read><file>src/A&amp;B.ts</file></files_read></observation>');
      const saved = store.storeObservation('memory', 'project', parsed, 1).id;
      expect(getObservationsByFilePath(store.db, 'src/A&B.ts', { projects: ['project'] }).map(row => row.id)).toEqual([saved]);
    } finally { store.close(); }
  });
  it('decodes summary fields and quoted skip reasons without double-decoding', () => {
    const summary = parseAgentXml('<summary><request>Ship &amp; verify &#x1F642;</request><learned>&lt;tag&gt; is text</learned></summary>');
    expect(summary.valid && summary.summary?.request).toBe('Ship & verify 🙂');
    expect(summary.valid && summary.summary?.learned).toBe('<tag> is text');
    const skip = parseAgentXml('<skip_summary reason="Already &quot;done&quot; &amp;lt;literal&amp;gt;"/>');
    expect(skip.valid && skip.summary?.skip_reason).toBe('Already "done" &lt;literal&gt;');
  });
  it('retains ordinary unescaped values and undeclared names as before', () => {
    const parsed = observation('<observation><type>discovery</type><title>A & B &unknown;</title><facts><fact>Plain fact</fact></facts></observation>');
    expect(parsed.title).toBe('A & B &unknown;'); expect(parsed.facts).toEqual(['Plain fact']);
    expect(observation('<observation><type>discovery</type><title>&#0; &#x110000; &#xD800;</title></observation>').title).toBe('&#0; &#x110000; &#xD800;');
    expect(observation('<observation><type>discovery</type><title><![CDATA[&amp;]]></title></observation>').title).toBe('<![CDATA[&amp;]]>');
  });
});
