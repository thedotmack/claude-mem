import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const store = new SessionStore();

// Simulate what the MCP handler does
const args = {
  anchor: 3300,
  depth_before: 10,
  depth_after: 10
};

console.log('Testing MCP handler logic with anchor:', args.anchor);

try {
  let timeline;
  const anchor = args.anchor;
  const depth_before = args.depth_before;
  const depth_after = args.depth_after;

  if (typeof anchor === 'number') {
    console.log('Anchor is number, getting observation...');
    const obs = store.getObservationById(anchor);
    if (!obs) {
      console.error('Observation not found!');
      process.exit(1);
    }
    console.log('Found observation:', obs.id, 'at epoch:', obs.created_at_epoch);

    console.log('Calling getTimelineAroundObservation...');
    timeline = store.getTimelineAroundObservation(anchor, obs.created_at_epoch, depth_before, depth_after);

    console.log('Timeline result:', {
      observations: timeline.observations?.length,
      sessions: timeline.sessions?.length,
      prompts: timeline.prompts?.length
    });

    console.log('Timeline observations type:', typeof timeline.observations);
    console.log('Timeline sessions type:', typeof timeline.sessions);
    console.log('Timeline prompts type:', typeof timeline.prompts);

    if (timeline.observations) {
      console.log('First observation:', timeline.observations[0]);
    }
  }

  console.log('\n✓ No errors!');
} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
}

store.close();
