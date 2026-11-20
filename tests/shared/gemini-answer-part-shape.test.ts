import { expect, test } from 'bun:test';
import { readGeminiAnswerText } from '../../src/shared/gemini-answer-text.js';
test('retains valid answer blocks beside malformed response parts', () => expect(readGeminiAnswerText([null,42,{text:'answer'}, {text:'hidden',thought:true}, {}, {text:' tail'}] as any)).toBe('answer tail'));
test('treats malformed non-array parts as an empty answer', () => expect(readGeminiAnswerText('unexpected' as any)).toBe(''));
test('does not substitute reasoning for an answer', () => expect(readGeminiAnswerText([{thought:true,text:'private'}])).toBe(''));
