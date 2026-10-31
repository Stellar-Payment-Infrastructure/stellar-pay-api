import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Paths that must never reach logs. Values are replaced with "[REDACTED]".
 * Secrets are also never passed to the logger on purpose; this is the
 * defense-in-depth layer.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'authorization',
  '*.authorization',
  'apiKey',
  '*.apiKey',
  'key',
  '*.key',
  'secret',
  '*.secret',
  'secretEnc',
  '*.secretEnc',
  'signedXdr',
  '*.signedXdr',
  'OPERATOR_SECRET',
  '*.OPERATOR_SECRET',
  'operatorSecret',
  '*.operatorSecret',
  'API_KEY_PEPPER',
  '*.API_KEY_PEPPER',
  'WEBHOOK_SECRET_ENC_KEY',
  '*.WEBHOOK_SECRET_ENC_KEY',
  'DATABASE_URL',
  '*.DATABASE_URL',
];

export function createLogger(
  opts: { level?: string; pretty?: boolean } = {},
  destination?: DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level: opts.level ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'stellar-pay-api' },
  };
  if (opts.pretty && !destination) {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
