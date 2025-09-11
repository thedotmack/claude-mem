import { OptionValues } from 'commander';
import { basename, dirname } from 'path';
import { 
  createLoadingMessage, 
  createCompletionMessage, 
  createOperationSummary,
  createUserFriendlyError 
} from '../prompts/templates/context/ContextTemplates.js';

export async function compress(transcript?: string, options: OptionValues = {}): Promise<void> {
  console.log(createLoadingMessage('compressing'));
  
  if (!transcript) {
    console.log(createUserFriendlyError('Compression', 'No transcript file provided', 'Please provide a path to a transcript file'));
    return;
  }

  try {
    const startTime = Date.now();
    
    // Import and run compression
    const { TranscriptCompressor } = await import('../core/compression/TranscriptCompressor.js');
    const compressor = new TranscriptCompressor({
      verbose: options.verbose || false
    });
    
    const sessionId = options.sessionId || basename(transcript, '.jsonl');
    const archivePath = await compressor.compress(transcript, sessionId);
    
    const duration = Date.now() - startTime;
    
    console.log(createCompletionMessage('Compression', undefined, `Session archived as ${basename(archivePath)}`));
    console.log(createOperationSummary('compress', { count: 1, duration, details: `Session: ${sessionId}` }));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(createUserFriendlyError(
      'Compression', 
      errorMessage, 
      'Check that the transcript file exists and you have write permissions'
    ));
    throw error; // Re-throw to maintain existing error handling behavior
  }
}