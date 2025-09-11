/**
 * Hook command handlers for binary distribution
 * These execute the actual hook logic embedded in the binary
 */

import { basename, sep } from 'path';
import { compress } from './compress.js';
import { loadContext } from './load-context.js';

/**
 * Pre-compact hook handler
 * Runs compression on the Claude Code transcript
 */
export async function preCompactHook(): Promise<void> {
  try {
    // Read hook data from stdin (Claude Code sends JSON)
    let inputData = '';
    
    // Set up stdin to read data
    process.stdin.setEncoding('utf8');
    
    // Collect all input data
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    
    // Parse the JSON input
    let transcriptPath: string | undefined;
    
    if (inputData) {
      try {
        const hookData = JSON.parse(inputData);
        transcriptPath = hookData.transcript_path;
      } catch (parseError) {
        // If JSON parsing fails, treat the input as a direct path
        transcriptPath = inputData.trim();
      }
    }
    
    // Fallback to environment variable or command line argument
    if (!transcriptPath) {
      transcriptPath = process.env.TRANSCRIPT_PATH || process.argv[2];
    }
    
    if (!transcriptPath) {
      console.log('🗜️ Compressing session transcript...');
      console.log('❌ No transcript path provided to pre-compact hook');
      console.log('Hook data received:', inputData || 'none');
      console.log('Environment TRANSCRIPT_PATH:', process.env.TRANSCRIPT_PATH || 'not set');
      console.log('Command line args:', process.argv.slice(2));
      return;
    }
    
    // Run compression with the transcript path
    await compress(transcriptPath, { dryRun: false });
  } catch (error: any) {
    console.error('Pre-compact hook failed:', error.message);
    process.exit(1);
  }
}

/**
 * Session-start hook handler
 * Loads context for the new session
 */
export async function sessionStartHook(): Promise<void> {
  try {
    // Read hook data from stdin (Claude Code sends JSON)
    let inputData = '';
    
    // Set up stdin to read data
    process.stdin.setEncoding('utf8');
    
    // Collect all input data
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    
    // Parse the JSON input to get the current working directory
    let project: string | undefined;
    
    if (inputData) {
      try {
        const hookData = JSON.parse(inputData);
        // Extract project name from cwd if provided
        if (hookData.cwd) {
          project = basename(hookData.cwd);
        }
      } catch (parseError) {
        // If JSON parsing fails, continue without project filtering
        console.error('Failed to parse session-start hook data:', parseError);
      }
    }
    
    // If no project from hook data, try to get from current working directory
    if (!project) {
      project = basename(process.cwd());
    }
    
    // Load context with session-start format and project filtering
    await loadContext({ format: 'session-start', count: '10', project });
  } catch (error: any) {
    console.error('Session-start hook failed:', error.message);
    process.exit(1);
  }
}

/**
 * Session-end hook handler
 * Compresses session transcript when ending with /clear
 */
export async function sessionEndHook(): Promise<void> {
  try {
    // Read hook data from stdin (Claude Code sends JSON)
    let inputData = '';
    
    // Set up stdin to read data
    process.stdin.setEncoding('utf8');
    
    // Collect all input data
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }
    
    // Parse the JSON input to check the reason for session end
    if (inputData) {
      try {
        const hookData = JSON.parse(inputData);
        
        // If reason is "clear", compress the session transcript before it's deleted
        if (hookData.reason === 'clear' && hookData.transcript_path) {
          console.log('🗜️ Compressing current session before /clear...');
          await compress(hookData.transcript_path, { dryRun: false });
        }
      } catch (parseError) {
        // If JSON parsing fails, log but don't fail the hook
        console.error('Failed to parse hook data:', parseError);
      }
    }
    
    console.log('Session ended successfully');
  } catch (error: any) {
    console.error('Session-end hook failed:', error.message);
    process.exit(1);
  }
}