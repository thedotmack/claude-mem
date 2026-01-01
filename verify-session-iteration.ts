
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Testing session iteration...');
  try {
    const session = unstable_v2_createSession({ model: 'claude-3-sonnet-20240229' });
    
    // Test if session is async iterable
    // @ts-ignore
    if (typeof session[Symbol.asyncIterator] === 'function') {
        console.log('Session IS async iterable');
    } else {
        console.log('Session is NOT async iterable');
    }

    // Test writing to inputStream
    // @ts-ignore
    if (session.inputStream && typeof session.inputStream.enqueue === 'function') {
        console.log('session.inputStream.enqueue is a function');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();
