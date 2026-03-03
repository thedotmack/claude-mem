import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Logger } from '../../../src/cli/utils/logger';

// Mock console methods
const originalLog = console.log;
const originalError = console.error;

describe('Logger', () => {
  let logs: string[] = [];
  let errors: string[] = [];

  beforeEach(() => {
    logs = [];
    errors = [];
    console.log = (...args: any[]) => logs.push(args.join(' '));
    console.error = (...args: any[]) => errors.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  describe('success', () => {
    it('should log success message with checkmark', () => {
      const logger = new Logger();
      logger.success('Test message');
      
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('✓');
      expect(logs[0]).toContain('Test message');
    });
  });

  describe('error', () => {
    it('should log error message with x mark', () => {
      const logger = new Logger();
      logger.error('Error message');
      
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('✗');
      expect(errors[0]).toContain('Error message');
    });

    it('should include stack trace in verbose mode', () => {
      const logger = new Logger(true);
      const error = new Error('Test error');
      logger.error('Error message', error);
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Error message');
    });
  });

  describe('warning', () => {
    it('should log warning message with warning symbol', () => {
      const logger = new Logger();
      logger.warning('Warning message');
      
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('⚠');
      expect(logs[0]).toContain('Warning message');
    });
  });

  describe('info', () => {
    it('should log info message with info symbol', () => {
      const logger = new Logger();
      logger.info('Info message');
      
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('ℹ');
      expect(logs[0]).toContain('Info message');
    });
  });

  describe('title', () => {
    it('should print formatted title', () => {
      const logger = new Logger();
      logger.title('Test Title');
      
      expect(logs.length).toBe(2);
      expect(logs[0]).toContain('Test Title');
      expect(logs[1]).toContain('═');
    });
  });

  describe('section', () => {
    it('should print section header', () => {
      const logger = new Logger();
      logger.section('Section Header');
      
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('Section Header');
    });
  });
});
