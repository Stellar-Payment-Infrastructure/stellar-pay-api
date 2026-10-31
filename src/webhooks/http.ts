import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { type Resolver, resolveSafeTarget, parseWebhookUrl, type UrlPolicy } from './ssrf.js';

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<DeliveryResult>;

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POSTs a webhook with SSRF protection: URL re-validated and DNS re-checked at
 * send time, connection pinned to the checked address, short timeout,
 * redirects not followed (3xx counts as failure), response size capped.
 */
export function createSender(opts: { policy: UrlPolicy; timeoutMs: number; resolver?: Resolver }): Sender {
  return async (rawUrl, body, headers) => {
    const started = Date.now();
    let url: URL;
    let target: { address: string; family: 4 | 6 };
    try {
      url = parseWebhookUrl(rawUrl, opts.policy);
      target = await resolveSafeTarget(url, opts.policy, opts.resolver);
    } catch {
      return { ok: false, ms: Date.now() - started, error: 'blocked: URL not allowed' };
    }
    const lookup: LookupFunction = (_host, options, cb) => {
      if (options && typeof options === 'object' && 'all' in options && options.all) {
        cb(null, [{ address: target.address, family: target.family }]);
      } else {
        cb(null, target.address, target.family);
      }
    };
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise<DeliveryResult>((resolve) => {
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
          timeout: opts.timeoutMs,
          lookup,
        },
        (res) => {
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) res.destroy();
          });
          const finish = () => {
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, ms: Date.now() - started });
          };
          res.on('end', finish);
          res.on('close', finish);
          res.on('error', finish);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => resolve({ ok: false, ms: Date.now() - started, error: err.message.slice(0, 200) }));
      req.end(body);
    });
  };
}
