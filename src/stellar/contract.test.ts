import { readFileSync } from 'node:fs';
import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { decodeEvent, eventToJson, statusForEvent } from './contract.js';

interface Vector {
  name: string;
  topics_xdr: string[];
  data_xdr: string;
  expected: Record<string, unknown>;
}
const vectors = JSON.parse(
  readFileSync(new URL('../generated/contract-test-vectors.json', import.meta.url), 'utf8'),
) as { event_version: number; events: Vector[] };

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const AT_FIELDS = ['created_at', 'paid_at', 'settled_at', 'refunded_at', 'cancelled_at'];

describe('decodeEvent against stellar-pay-core test vectors', () => {
  it('has vectors for every lifecycle event', () => {
    expect(new Set(vectors.events.map((v) => v.name))).toEqual(new Set(['created', 'paid', 'settled', 'refunded', 'cancelled']));
  });

  for (const [i, v] of vectors.events.entries()) {
    it(`decodes vector #${i} (${v.name}) exactly`, () => {
      const res = decodeEvent(
        v.topics_xdr.map((t) => xdr.ScVal.fromXDR(t, 'base64')),
        xdr.ScVal.fromXDR(v.data_xdr, 'base64'),
      );
      expect(res.kind).toBe('event');
      if (res.kind !== 'event') return;
      const json = eventToJson(res.event);
      expect(json['name']).toBe(v.name);
      for (const [k, want] of Object.entries(v.expected)) {
        const key = AT_FIELDS.includes(k) ? 'at' : k === 'settle_mode' ? 'settleMode' : camel(k);
        expect(json[key], `${v.name}.${k}`).toEqual(want);
      }
      expect(statusForEvent(res.event)).toBe(v.name);
    });
  }
});

describe('decodeEvent robustness', () => {
  const first = vectors.events[0] as Vector;
  const topics = first.topics_xdr.map((t) => xdr.ScVal.fromXDR(t, 'base64'));
  const data = xdr.ScVal.fromXDR(first.data_xdr, 'base64');

  it('skips unknown versions instead of throwing', () => {
    const m = data.map() ?? [];
    const bumped = xdr.ScVal.scvMap(
      m.map((e) => (e.key().sym().toString() === 'v' ? new xdr.ScMapEntry({ key: e.key(), val: xdr.ScVal.scvU32(2) }) : e)),
    );
    expect(decodeEvent(topics, bumped)).toMatchObject({ kind: 'unknown', reason: 'unsupported event version 2' });
  });

  it('skips foreign topics, unknown names and malformed data', () => {
    expect(decodeEvent([xdr.ScVal.scvSymbol('transfer'), topics[1] as xdr.ScVal], data).kind).toBe('unknown');
    expect(decodeEvent([topics[0] as xdr.ScVal, xdr.ScVal.scvSymbol('mystery')], data)).toMatchObject({ kind: 'unknown', name: 'mystery' });
    expect(decodeEvent(topics, xdr.ScVal.scvU32(1)).kind).toBe('unknown');
    expect(decodeEvent([topics[0] as xdr.ScVal], data).kind).toBe('unknown');
  });
});
