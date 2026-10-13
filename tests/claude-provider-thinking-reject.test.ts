import { describe, expect, it } from 'bun:test';
import { describeErrorFeedbackText, isThinkingRejectFeedback } from '../src/services/worker/ClaudeProvider.js';

/**
 * Regression coverage for #4732: a gateway that maps every `claude-*` model to
 * an always-thinking upstream (e.g. thudm/glm-5.3-flash) rejects the observer's
 * hardcoded `thinking:{type:"disabled"}` with HTTP 400 / code 1210, and the
 * resulting empty reply flowed down the no-observation-XML path where the whole
 * claimed batch was dropped — 134 consecutive failures over ~4 hours, zero
 * memories saved. The provider must recognize this exact rejection so it can
 * pause the generation as a transport exit and retry the next one with the
 * param stripped.
 */
describe('isThinkingRejectFeedback (#4732)', () => {
  it('matches the GLM 1210 rejection verbatim from the issue', () => {
    expect(isThinkingRejectFeedback(
      'API Error: 400 {[1210][该模型始终思考，不支持关闭思考；请使用 low、high 或 max。]} (model_id: thudm-glm-5.3-flash)',
    )).toBe(true);
  });

  it('matches an Anthropic-shaped invalid_request_error that names thinking', () => {
    expect(isThinkingRejectFeedback(
      'invalid_request_error: thinking.type may not be "disabled" for this model',
    )).toBe(true);
    expect(isThinkingRejectFeedback(
      'Request failed with status 400: thinking parameter is not supported by this model',
    )).toBe(true);
  });

  it('matches thinking rejections surfaced through a structured error body', () => {
    expect(isThinkingRejectFeedback(
      'Bad request — {"type":"error","error":{"type":"invalid_request_error","message":"thinking is not supported"}}',
    )).toBe(true);
  });

  it('matches a thrown error whose 400 is only in the structured status', () => {
    const thrown = Object.assign(new Error('thinking parameter is not supported'), { status: 400 });
    expect(isThinkingRejectFeedback(describeErrorFeedbackText(thrown))).toBe(true);
    const thrownWithStatusCode = Object.assign(new Error('thinking parameter is not supported'), { statusCode: 400 });
    expect(isThinkingRejectFeedback(describeErrorFeedbackText(thrownWithStatusCode))).toBe(true);
    // Without any status the message alone doesn't say the request was refused.
    expect(isThinkingRejectFeedback(describeErrorFeedbackText(new Error('thinking parameter is not supported')))).toBe(false);
  });

  it('does not match an unrelated 400 (effort, prompt length)', () => {
    expect(isThinkingRejectFeedback('This model does not support the effort parameter.')).toBe(false);
    expect(isThinkingRejectFeedback('Prompt is too long: 250000 tokens > 200000 maximum')).toBe(false);
    expect(isThinkingRejectFeedback('invalid_request_error: model not found')).toBe(false);
  });

  it('does not match ordinary prose that merely contains "thinking"', () => {
    expect(isThinkingRejectFeedback('I am thinking about the problem and will answer next.')).toBe(false);
  });

  it('does not match an auth or quota refusal', () => {
    expect(isThinkingRejectFeedback('Invalid API key · Please run /login')).toBe(false);
    expect(isThinkingRejectFeedback('quota exceeded for this billing window')).toBe(false);
  });

  it('treats empty feedback as a non-match', () => {
    expect(isThinkingRejectFeedback('')).toBe(false);
  });
});
