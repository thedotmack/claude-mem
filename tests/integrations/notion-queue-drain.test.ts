import { expect, test } from 'bun:test';
import { NotionExporter, type NotionObservationRecord } from '../../src/services/integrations/NotionExporter.js';

test('queue is completely drained at every microtask boundary around the last upsert', async () => {
  for (let delay = 0; delay < 10; delay++) {
    const exporter = new NotionExporter({ token: 'unused', databaseId: 'unused', sourceId: 'test' });
    let finish!: (result: 'created') => void;
    const first = new Promise<'created'>(resolve => { finish = resolve; });
    const exported: number[] = [];
    exporter.upsert = async record => {
      exported.push(record.observationId);
      return record.observationId === 1 ? first : 'created';
    };
    exporter.enqueue({ observationId: 1 } as NotionObservationRecord);
    finish('created');
    for (let tick = 0; tick < delay; tick++) await Promise.resolve();
    exporter.enqueue({ observationId: 2 } as NotionObservationRecord);
    await exporter.idle();
    expect({ delay, exported, pending: exporter.pending }).toEqual({ delay, exported: [1, 2], pending: 0 });
  }
});
