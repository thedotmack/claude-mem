import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Inspecting SDK V2 session object...');
  try {
    const session = unstable_v2_createSession({ model: 'claude-3-sonnet-20240229' });
    
    // @ts-ignore
    console.log('inputStream:', session.inputStream);
    // @ts-ignore
    console.log('query:', session.query);
    // @ts-ignore
    console.log('queryIterator:', session.queryIterator);
    
    // Check if queryIterator is async iterable
    // @ts-ignore
    if (session.queryIterator && typeof session.queryIterator[Symbol.asyncIterator] === 'function') {
        console.log('queryIterator is AsyncIterable');
    } else {
        console.log('queryIterator is NOT AsyncIterable');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    console.log('Exiting...');
    process.exit(0);
  }
}

main();