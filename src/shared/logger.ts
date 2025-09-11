/**
 * Simple logging utility for claude-mem
 */

export interface LogLevel {
  DEBUG: number;
  INFO: number;
  WARN: number;
  ERROR: number;
}

const LOG_LEVELS: LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class Logger {
  // <Block> 2.1 ====================================
  private level: number = LOG_LEVELS.INFO;
  
  setLevel(level: keyof LogLevel): void {
    this.level = LOG_LEVELS[level];
  }
  // </Block> =======================================
  
  // <Block> 2.2 ====================================
  debug(message: string, ...args: any[]): void {
    if (this.level <= LOG_LEVELS.DEBUG) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
  // </Block> =======================================
  
  // <Block> 2.3 ====================================
  info(message: string, ...args: any[]): void {
    if (this.level <= LOG_LEVELS.INFO) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }
  // </Block> =======================================
  
  // <Block> 2.4 ====================================
  warn(message: string, ...args: any[]): void {
    if (this.level <= LOG_LEVELS.WARN) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }
  // </Block> =======================================
  
  // <Block> 2.5 ====================================
  error(message: string, error?: any, context?: any): void {
    if (this.level <= LOG_LEVELS.ERROR) {
      console.error(`[ERROR] ${message}`);
      if (error) {
        console.error(error);
      }
      if (context) {
        console.error('Context:', context);
      }
    }
  }
  // </Block> =======================================
}

export const log = new Logger();