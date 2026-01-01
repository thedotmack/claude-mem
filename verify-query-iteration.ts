
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Testing session.query iteration...');
  try {
    const session = unstable_v2_createSession({ model: 'claude-3-sonnet-20240229' });
    
    // @ts-ignore
    if (session.query && typeof session.query[Symbol.asyncIterator] === 'function') {
        console.log('session.query IS async iterable');
    } else {
        console.log('session.query is NOT async iterable');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();
