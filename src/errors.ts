/**
 * Exit codes (D34-5). Stable: scripts and agents branch on them.
 */
export const ExitCode = {
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
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * ToolErrorCode (app/Mcp/ToolErrorCode.php in the Radiance repository) -> exit code.
 * Frozen by test/error-codes.test.ts.
 */
export const TOOL_ERROR_EXIT: Readonly<Record<string, ExitCodeValue>> = {
  unauthenticated: ExitCode.Unauthenticated,
  insufficient_tokens: ExitCode.InsufficientTokens,
  not_found: ExitCode.NotFound,
  not_owned: ExitCode.NotFound,
  not_ready: ExitCode.NotReady,
  precondition_failed: ExitCode.NotReady,
  rate_limited: ExitCode.RateLimited,
  account_inactive: ExitCode.Platform,
  permission_not_granted: ExitCode.Platform,
  unsupported_platform: ExitCode.Platform,
  messaging_window_closed: ExitCode.Platform,
  upstream_failed: ExitCode.Platform,
};

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCodeValue,
    /** Raw tool result, echoed in --json output. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedToolError {
  code: string;
  disposition: string | null;
  message: string;
  exitCode: ExitCodeValue;
}

/**
 * Tools report failures as `[code · disposition(, retry after Ns)] message Next: ...`
 * (app/Mcp/Tools/Concerns/ReportsToolErrors.php).
 */
export function parseToolError(text: string): ParsedToolError {
  const match = /^\s*\[([a-z_]+)\s*·\s*([a-z_]+)[^\]]*\]\s*([\s\S]*)$/.exec(text);
  if (match) {
    const code = match[1] as string;
    return {
      code,
      disposition: match[2] ?? null,
      message: (match[3] ?? '').trim(),
      exitCode: TOOL_ERROR_EXIT[code] ?? ExitCode.Unexpected,
    };
  }
  // Some guards answer with a bare sentence rather than the tagged shape.
  if (/authentication required/i.test(text)) {
    return { code: 'unauthenticated', disposition: null, message: text.trim(), exitCode: ExitCode.Unauthenticated };
  }
  return { code: 'unknown', disposition: null, message: text.trim(), exitCode: ExitCode.Unexpected };
}
