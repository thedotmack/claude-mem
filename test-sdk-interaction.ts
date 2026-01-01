
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Helper to wrap SDK session if it lacks V2 methods (polyfills for 0.1.76+ transitional API)
 */
function wrapSession(session: any) {
  if (typeof session.receive === 'function') {
    return session;
  }

  // Polyfill for SDK versions where unstable_v2_createSession returns a hybrid object
  // without explicit send/receive methods, but with inputStream and query iterator.
  return {
    async send(text: string) {
      if (session.inputStream && typeof session.inputStream.enqueue === 'function') {
        console.log('Sending message to inputStream...');
        session.inputStream.enqueue({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] }
        });
      } else {
        throw new Error('Session missing inputStream.enqueue');
      }
    },
    async *receive() {
      // Iterate over the session's query stream (which yields all messages)
      // Stop when we see a completed assistant message
      if (!session.query) throw new Error('Session missing query iterator');
      
      console.log('Starting receive loop...');
      for await (const msg of session.query) {
         console.log('Received message type:', msg.type);
         yield msg;
         // In this SDK version, assistant messages are yielded complete if includePartialMessages is false (default)
         if (msg.type === 'assistant') {
             console.log('Assistant message complete, returning from receive');
             return; 
         }
      }
    },
    close() {
       if (session.abortController) session.abortController.abort();
    },
    [Symbol.asyncDispose]: async function() {
        this.close();
    }
  };
}

async function main() {
  console.log('Testing SDK interaction...');
  try {
    const rawSession = unstable_v2_createSession({ model: 'claude-3-5-sonnet-20241022' });
    const session = wrapSession(rawSession);
    
    console.log('Session created. Sending prompt...');
    await session.send('What is 2 + 2?');
    
    console.log('Waiting for response...');
    for await (const msg of session.receive()) {
        if (msg.type === 'assistant') {
            // @ts-ignore
            const text = msg.message.content
                // @ts-ignore
                .filter(block => block.type === 'text')
                // @ts-ignore
                .map(block => block.text)
                .join('');
            console.log('Assistant response:', text);
        }
    }
    
    console.log('Success!');

  } catch (error) {
    console.error('Error during interaction:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();
