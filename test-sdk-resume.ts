
import {
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

function wrapSession(session: any) {
  // Same wrapper...
  return {
    async send(text: string) {
      if (session.inputStream && typeof session.inputStream.enqueue === 'function') {
        session.inputStream.enqueue({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        });
      }
    },
    async *receive() {
      if (!session.query) throw new Error('Session missing query iterator');
      for await (const msg of session.query) {
         console.log('Received:', msg.type);
         yield msg;
         if (msg.type === 'assistant') return;
      }
    },
    close() { if (session.abortController) session.abortController.abort(); },
    [Symbol.asyncDispose]: async function() { this.close(); }
  };
}

async function main() {
  console.log('Testing SDK Session Resume with FAKE ID...');
  try {
    const fakeId = 'ad3de735-f8ae-412b-82e4-36e12cf6ad62'; // ID from logs
    console.log(`Resuming session ${fakeId}...`);
    
    const rawSession = unstable_v2_resumeSession(fakeId, { model: 'claude-3-5-sonnet-20241022' });
    const session = wrapSession(rawSession);
    
    console.log('Sending message...');
    await session.send('Hello?');
    
    console.log('Receiving...');
    for await (const msg of session.receive()) {
        console.log('Message:', msg.type);
    }

  } catch (error) {
    console.error('Error during resume:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();
