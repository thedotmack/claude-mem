import { expect, test } from 'bun:test';
import { isConnectionRefusedError } from '../../src/shared/connection-errors.js';
test('recognizes message-only refusal within an error cause chain', () => expect(isConnectionRefusedError(new Error('request failed', {cause:new Error('connect ECONNREFUSED 127.0.0.1:37777')}))).toBe(true));
test('recognizes message-only refusal within AggregateError children', () => expect(isConnectionRefusedError(new AggregateError([new Error('connect ECONNREFUSED ::1:37777')],'fetch failed'))).toBe(true));
test('keeps non-refusal text and cyclic causes safe', () => {const error=new Error('Unable to connect');(error as any).cause=error;expect(isConnectionRefusedError(error)).toBe(false);});
