import { afterEach, describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createServer, type PuntovivoServer } from '../index.js';
import {
  LOCAL_AUTH_CAPABILITY_HEADER,
  assertLocalAuthCapability,
  createLocalAuthCapability,
} from '../security/localAuthCapability.js';
import { __REDACT_PATHS_FOR_TESTS } from '../logging/logger.js';
import { __TEST_SENSITIVE_KEYS } from '../services/diagnostics/sanitize.js';
import type { Context } from '../trpc/context.js';

const servers: PuntovivoServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function boot() {
  const server = await createServer({ dbPath: ':memory:', verbose: false });
  servers.push(server);
  return server;
}

function ctxFor(server: PuntovivoServer, headerValue?: string | string[]): Context {
  const headers: Record<string, string | string[]> = {};
  if (headerValue !== undefined) headers[LOCAL_AUTH_CAPABILITY_HEADER] = headerValue;
  return { req: { headers, server: server.app } } as unknown as Context;
}

describe('local auth capability', () => {
  it('uses the agreed header name', () => {
    expect(LOCAL_AUTH_CAPABILITY_HEADER).toBe('x-puntovivo-local-auth');
  });

  it('matches its own token', () => {
    const cap = createLocalAuthCapability();
    expect(cap.token).toMatch(/^[0-9a-f]{64}$/);
    expect(cap.matches(cap.token)).toBe(true);
  });

  it('rejects wrong and missing capability', () => {
    const cap = createLocalAuthCapability();
    expect(cap.matches(undefined)).toBe(false);
    expect(cap.matches('')).toBe(false);
    expect(cap.matches('a'.repeat(64))).toBe(false);
    expect(cap.matches([cap.token])).toBe(false);
  });

  it('two servers get different tokens', async () => {
    const first = await boot();
    const firstToken = first.getLocalAuthCapability();
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    await servers.pop()!.close();
    const second = await boot();
    expect(second.getLocalAuthCapability()).toMatch(/^[0-9a-f]{64}$/);
    expect(second.getLocalAuthCapability()).not.toBe(firstToken);
  });

  it('assertLocalAuthCapability passes with the server token and throws otherwise', async () => {
    const server = await boot();
    expect(() =>
      assertLocalAuthCapability(ctxFor(server, server.getLocalAuthCapability()))
    ).not.toThrow();
    for (const bad of [undefined, '', 'b'.repeat(64), [server.getLocalAuthCapability()]]) {
      try {
        assertLocalAuthCapability(ctxFor(server, bad));
        expect.unreachable('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TRPCError);
        expect((err as TRPCError).code).toBe('UNAUTHORIZED');
        expect((err as TRPCError).cause).toMatchObject({ errorCode: 'AUTH_PIN_LOGIN_UNAVAILABLE' });
      }
    }
  });

  it('is redacted from logs and diagnostics', () => {
    expect(__REDACT_PATHS_FOR_TESTS).toContain('headers["x-puntovivo-local-auth"]');
    expect(__REDACT_PATHS_FOR_TESTS).toContain('req.headers["x-puntovivo-local-auth"]');
    expect(__TEST_SENSITIVE_KEYS.has('xpuntovivolocalauth')).toBe(true);
  });
});
