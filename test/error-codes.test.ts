import { describe, expect, it } from 'vitest';
import { ExitCode, TOOL_ERROR_EXIT, parseToolError } from '../src/errors.js';

describe('ToolErrorCode -> exit code table', () => {
  // Frozen: changing a line here changes a contract that scripts and agents rely on.
  // Source of codes: app/Mcp/ToolErrorCode.php in the Radiance repository.
  it('is frozen', () => {
    expect(TOOL_ERROR_EXIT).toEqual({
      unauthenticated: 4,
      insufficient_tokens: 5,
      not_found: 6,
      not_owned: 6,
      not_ready: 7,
      precondition_failed: 7,
      rate_limited: 8,
      account_inactive: 9,
      permission_not_granted: 9,
      unsupported_platform: 9,
      messaging_window_closed: 9,
      upstream_failed: 9,
    });
  });

  it('keeps the documented exit code values', () => {
    expect(ExitCode).toEqual({
      Success: 0,
      Unexpected: 1,
      Usage: 2,
      ConfirmationRequired: 3,
      Unauthenticated: 4,
      InsufficientTokens: 5,
      NotFound: 6,
      NotReady: 7,
      RateLimited: 8,
      Platform: 9,
    });
  });
});

describe('parseToolError', () => {
  it('reads the tagged shape produced by ReportsToolErrors', () => {
    const parsed = parseToolError('[not_ready · retry, retry after 30s] The video is still processing. Next: wait.');
    expect(parsed).toMatchObject({ code: 'not_ready', disposition: 'retry', exitCode: 7 });
    expect(parsed.message).toBe('The video is still processing. Next: wait.');
  });

  it('reads a code without a retry hint', () => {
    expect(parseToolError('[insufficient_tokens · needs_human] Not enough tokens. Next: buy.').exitCode).toBe(5);
  });

  it('maps the bare authentication sentence to unauthenticated', () => {
    expect(parseToolError('Authentication required. Provide a valid Sanctum bearer token.')).toMatchObject({
      code: 'unauthenticated',
      exitCode: 4,
    });
  });

  it('falls back to exit 1 for an unknown or untagged error', () => {
    expect(parseToolError('[brand_new · permanent] Something.')).toMatchObject({ code: 'brand_new', exitCode: 1 });
    expect(parseToolError('boom')).toMatchObject({ code: 'unknown', exitCode: 1 });
  });
});
