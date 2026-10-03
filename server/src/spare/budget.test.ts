import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { BUDGET_CAPACITY, clientKey, createTokenBucket, rateLimitKey, ROUNDUP_REPLAY_COST, rpcMessageCost, toolCost } from './budget.js';

describe('read budget', () => {
  it('prices scan-heavy tools higher, whatever name form is used', () => {
    expect(toolCost('spare_activity', {})).toBe(6);
    expect(toolCost('activity', {})).toBe(6);
    expect(toolCost('spare_fees', {})).toBe(4);
    expect(toolCost('spare_roundup_preview', { amountUsd: '3.75' })).toBe(1);
    expect(toolCost('spare_roundup_preview', { wallet: '0x7e57000000000000000000000000000000000001' })).toBe(ROUNDUP_REPLAY_COST);
    expect(toolCost('spare_unknown_tool', {})).toBe(1);
  });

  it('an empty wallet= next to a real address still pays the replay price (the handler replays it)', () => {
    const addr = '0x7e57000000000000000000000000000000000001';
    expect(toolCost('spare_roundup_preview', { wallet: '', address: addr })).toBe(ROUNDUP_REPLAY_COST);
    expect(toolCost('roundup_preview', { wallet: null, account: addr })).toBe(ROUNDUP_REPLAY_COST);
    expect(toolCost('spare_roundup_preview', { wallet: '', address: '', account: '' })).toBe(1);
    expect(rpcMessageCost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spare_roundup_preview', arguments: { wallet: '', address: addr } } })).toBe(
      ROUNDUP_REPLAY_COST,
    );
  });

  it('charges tools/call by tool and every other JSON-RPC message 1', () => {
    expect(rpcMessageCost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spare_activity', arguments: {} } })).toBe(6);
    expect(rpcMessageCost({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(1);
    expect(rpcMessageCost({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(1);
    expect(rpcMessageCost('garbage')).toBe(1);
  });

  it('token bucket: spends, refuses with a wait, refills over the window', () => {
    const b = createTokenBucket(10, 10_000); // 1 token / s
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(b.take('ip', 1, t0)).toBe(0);
    expect(b.take('ip', 1, t0)).toBeGreaterThan(0);
    expect(b.take('other-ip', 1, t0)).toBe(0); // per key
    expect(b.take('ip', 1, t0 + 1_000)).toBe(0); // refilled one token
    expect(b.take('ip', 6, t0 + 1_000)).toBe(6); // needs 6 more seconds
    expect(b.take('ip', 11, t0 + 60_000)).toBeGreaterThan(0); // more than capacity never fits
  });

  it('rateLimitKey: IPv4 as is, mapped IPv4 unwrapped, IPv6 by /64 (engine rateLimitKey)', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('[2001:DB8:1:2:3:4:5:6]')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
    expect(rateLimitKey('unknown')).toBe('unknown');
  });

  it('one host rotating through its IPv6 /64 is one client; a mapped IPv4 is that IPv4', () => {
    const req = (ip: string | undefined, remoteAddress?: string) => ({ ip, socket: { remoteAddress } }) as unknown as Request;
    const b = createTokenBucket(10, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(b.take(clientKey(req(`2001:db8:1:2::${(i + 1).toString(16)}`)), 1, t0)).toBe(0);
    expect(b.take(clientKey(req('2001:db8:1:2:ffff:ffff:ffff:ffff')), 1, t0)).toBeGreaterThan(0);
    expect(b.take(clientKey(req('2001:db8:1:3::1')), 1, t0)).toBe(0); // the next /64 is someone else
    expect(clientKey(req('::ffff:198.51.100.4'))).toBe(clientKey(req('198.51.100.4')));
    expect(clientKey(req(undefined, '::ffff:198.51.100.4'))).toBe('198.51.100.4');
    expect(clientKey(req(undefined))).toBe('unknown');
  });

  it('a 10-call spare_activity batch exactly fills one minute of budget', () => {
    expect(10 * toolCost('spare_activity', {})).toBe(BUDGET_CAPACITY);
  });
});
