import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const store = new SessionStore();

console.log('=== Test 1: Without project filter ===');
try {
  const result = store.getTimelineAroundTimestamp(
    1730667961000, // timestamp for observation 3300
    5,
    5
  );

  console.log('Result:', {
    observations: result?.observations?.length,
    sessions: result?.sessions?.length,
    prompts: result?.prompts?.length
  });
} catch (err) {
  console.error('ERROR:', err);
}

console.log('\n=== Test 2: With project filter ===');
try {
  const result = store.getTimelineAroundTimestamp(
    1730667961000,
    5,
    5,
    'claude-mem'
  );

  console.log('Result:', {
    observations: result?.observations?.length,
    sessions: result?.sessions?.length,
    prompts: result?.prompts?.length
  });
} catch (err) {
  console.error('ERROR:', err);
}

console.log('\n=== Test 3: With actual observation ID ===');
// First get the actual timestamp for observation 3300
const obs = store.getObservationById(3300);
console.log('Observation 3300:', obs ? `Found at epoch ${obs.created_at_epoch}` : 'Not found');

if (obs) {
  try {
    const result = store.getTimelineAroundTimestamp(
      obs.created_at_epoch,
      5,
      5
    );

    console.log('Result:', {
      observations: result?.observations?.length,
      sessions: result?.sessions?.length,
      prompts: result?.prompts?.length
    });

    console.log('Observations:', result.observations?.map(o => `#${o.id}`));
    console.log('Sessions:', result.sessions?.map(s => `#S${s.id}`));
    console.log('Prompts:', result.prompts?.map(p => `#P${p.id}`));
  } catch (err) {
    console.error('ERROR:', err);
  }
}

store.close();
