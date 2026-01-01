
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Testing inputStream...');
  try {
    const session = unstable_v2_createSession({ model: 'claude-3-sonnet-20240229' });
    
    // @ts-ignore
    console.log('Enqueueing string...');
    try {
        // @ts-ignore
        session.inputStream.enqueue("Hello");
        console.log('String enqueued successfully');
    } catch (e) {
        console.error('Failed to enqueue string:', e);
    }
    
    // @ts-ignore
    console.log('Enqueueing V1 object...');
    try {
        const msg = {
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: "Hello" }] }
        };
        // @ts-ignore
        session.inputStream.enqueue(msg);
        console.log('V1 object enqueued successfully');
    } catch (e) {
        console.error('Failed to enqueue object:', e);
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();
