import { OptionValues } from 'commander';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as paths from '../shared/paths.js';

// <Block> 1.1 ====================================
async function showLog(logPath: string, logType: string, tail: number): Promise<void> {
  // <Block> 1.2 ====================================
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const displayLines = lines.slice(-tail);
    
    console.log(`📋 ${logType} Logs (last ${tail} lines):`);
    console.log(`   File: ${logPath}`);
    console.log('');
    
    // <Block> 1.3 ====================================
    if (displayLines.length === 0) {
      console.log('   No log entries found');
    // </Block> =======================================
    } else {
      displayLines.forEach(line => {
        console.log(`   ${line}`);
      });
    }
    // </Block> =======================================
    
    console.log('');
  // </Block> =======================================
  } catch (error) {
    // <Block> 1.4 ====================================
    console.log(`❌ Could not read ${logType.toLowerCase()} log: ${logPath}`);
    // </Block> =======================================
  }
// </Block> =======================================
}

// <Block> 2.1 ====================================
export async function logs(options: OptionValues = {}): Promise<void> {
  // <Block> 2.2 ====================================
  const logsDir = paths.LOGS_DIR;
  const tail = parseInt(options.tail) || 20;
  // </Block> =======================================
  
  // Find most recent log file
  try {
    const files = readdirSync(logsDir);
    const logFiles = files
      .filter(f => f.startsWith('claude-mem-') && f.endsWith('.log'))
      .map(f => ({ 
        name: f, 
        path: join(logsDir, f),
        mtime: statSync(join(logsDir, f)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    
    if (logFiles.length === 0) {
      console.log('❌ No log files found in ~/.claude-mem/logs/');
      return;
    }
    
    // Show most recent log
    await showLog(logFiles[0].path, 'Most Recent', tail);
    
    if (options.all && logFiles.length > 1) {
      console.log(`📚 Found ${logFiles.length} total log files`);
    }
  } catch (error) {
    console.log('❌ Could not read logs directory: ~/.claude-mem/logs/');
    console.log('   Run a compression first to generate logs');
  }
}