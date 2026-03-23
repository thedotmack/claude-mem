import { describe, it, expect } from 'bun:test';
import {
  CLIError,
  ExitCode,
  workerNotRunning,
  validationError,
  notFoundError,
  workerError,
  internalError,
} from '../src/errors.ts';

// ─── ExitCode enum ────────────────────────────────────────────────────────

describe('ExitCode', () => {
  it('SUCCESS is 0', () => {
    expect(ExitCode.SUCCESS).toBe(0);
  });

  it('WORKER_ERROR is 1', () => {
    expect(ExitCode.WORKER_ERROR).toBe(1);
  });

  it('CONNECTION_ERROR is 2', () => {
    expect(ExitCode.CONNECTION_ERROR).toBe(2);
  });

  it('VALIDATION_ERROR is 3', () => {
    expect(ExitCode.VALIDATION_ERROR).toBe(3);
  });

  it('NOT_FOUND is 4', () => {
    expect(ExitCode.NOT_FOUND).toBe(4);
  });

  it('INTERNAL_ERROR is 5', () => {
    expect(ExitCode.INTERNAL_ERROR).toBe(5);
  });
});

// ─── CLIError constructor ─────────────────────────────────────────────────

describe('CLIError', () => {
  it('is an instance of Error', () => {
    const err = new CLIError('msg', ExitCode.SUCCESS);
    expect(err).toBeInstanceOf(Error);
  });

  it('sets name to CLIError', () => {
    const err = new CLIError('msg', ExitCode.SUCCESS);
    expect(err.name).toBe('CLIError');
  });

  it('sets message correctly', () => {
    const err = new CLIError('something went wrong', ExitCode.VALIDATION_ERROR);
    expect(err.message).toBe('something went wrong');
  });

  it('sets code correctly', () => {
    const err = new CLIError('msg', ExitCode.NOT_FOUND);
    expect(err.code).toBe(ExitCode.NOT_FOUND);
  });

  it('sets hint when provided', () => {
    const err = new CLIError('msg', ExitCode.SUCCESS, 'try this fix');
    expect(err.hint).toBe('try this fix');
  });

  it('hint is undefined when not provided', () => {
    const err = new CLIError('msg', ExitCode.SUCCESS);
    expect(err.hint).toBeUndefined();
  });

  it('sets data when provided', () => {
    const payload = { extra: 'info' };
    const err = new CLIError('msg', ExitCode.WORKER_ERROR, undefined, payload);
    expect(err.data).toEqual(payload);
  });

  it('data is undefined when not provided', () => {
    const err = new CLIError('msg', ExitCode.SUCCESS);
    expect(err.data).toBeUndefined();
  });
});

// ─── workerNotRunning ─────────────────────────────────────────────────────

describe('workerNotRunning', () => {
  it('returns a CLIError', () => {
    expect(workerNotRunning('http://127.0.0.1:37777')).toBeInstanceOf(CLIError);
  });

  it('message includes the base URL', () => {
    const err = workerNotRunning('http://127.0.0.1:37777');
    expect(err.message).toContain('http://127.0.0.1:37777');
  });

  it('code is CONNECTION_ERROR', () => {
    const err = workerNotRunning('http://127.0.0.1:37777');
    expect(err.code).toBe(ExitCode.CONNECTION_ERROR);
  });

  it('hint contains actionable text', () => {
    const err = workerNotRunning('http://127.0.0.1:37777');
    expect(err.hint).toBeTruthy();
    expect(typeof err.hint).toBe('string');
    // Should mention the worker start command
    expect(err.hint).toContain('worker');
  });
});

// ─── validationError ──────────────────────────────────────────────────────

describe('validationError', () => {
  it('returns a CLIError', () => {
    expect(validationError('bad input')).toBeInstanceOf(CLIError);
  });

  it('message matches the provided string', () => {
    const err = validationError('query is too long');
    expect(err.message).toBe('query is too long');
  });

  it('code is VALIDATION_ERROR', () => {
    const err = validationError('any message');
    expect(err.code).toBe(ExitCode.VALIDATION_ERROR);
  });
});

// ─── notFoundError ────────────────────────────────────────────────────────

describe('notFoundError', () => {
  it('returns a CLIError', () => {
    expect(notFoundError('observation not found')).toBeInstanceOf(CLIError);
  });

  it('message matches the provided string', () => {
    const err = notFoundError('record 42 does not exist');
    expect(err.message).toBe('record 42 does not exist');
  });

  it('code is NOT_FOUND', () => {
    const err = notFoundError('not found');
    expect(err.code).toBe(ExitCode.NOT_FOUND);
  });
});

// ─── workerError ─────────────────────────────────────────────────────────

describe('workerError', () => {
  it('returns a CLIError', () => {
    expect(workerError('internal worker failure')).toBeInstanceOf(CLIError);
  });

  it('message matches the provided string', () => {
    const err = workerError('DB write failed');
    expect(err.message).toBe('DB write failed');
  });

  it('code is WORKER_ERROR', () => {
    const err = workerError('some error');
    expect(err.code).toBe(ExitCode.WORKER_ERROR);
  });

  it('attaches data payload when provided', () => {
    const payload = { rows: 0 };
    const err = workerError('insert failed', payload);
    expect(err.data).toEqual(payload);
  });

  it('data is undefined when not provided', () => {
    const err = workerError('some error');
    expect(err.data).toBeUndefined();
  });
});

// ─── internalError ────────────────────────────────────────────────────────

describe('internalError', () => {
  it('returns a CLIError', () => {
    expect(internalError('unexpected state')).toBeInstanceOf(CLIError);
  });

  it('message matches the provided string', () => {
    const err = internalError('null pointer');
    expect(err.message).toBe('null pointer');
  });

  it('code is INTERNAL_ERROR', () => {
    const err = internalError('oops');
    expect(err.code).toBe(ExitCode.INTERNAL_ERROR);
  });
});
