import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { PuntovivoServer } from '@puntovivo/server';
import { createLocalAuthFetch } from '../session/local-auth-fetch.ts';

const ORIGIN = 'http://127.0.0.1:8090';
const HEADER = 'x-puntovivo-local-auth';

function fakeServer() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const server = {
    getLocalAuthCapability: () => 'boot-secret',
    app: {
      inject: async (opts: { url: string; headers: Record<string, string> }) => {
        calls.push({ url: opts.url, headers: opts.headers });
        return { statusCode: 200, headers: {}, body: '{}' };
      },
    },
  } as unknown as PuntovivoServer;
  return { server, calls };
}

const post = (headers?: Record<string, string>) => ({
  method: 'POST',
  ...(headers ? { headers } : {}),
});

describe('createLocalAuthFetch PIN capability', () => {
  it('injects capability header only for pin paths', async () => {
    const { server, calls } = fakeServer();
    const f = createLocalAuthFetch(() => server, ORIGIN);
    await f(`${ORIGIN}/api/trpc/auth.pinLogin?batch=1`, post());
    await f(`${ORIGIN}/api/trpc/auth.pinLoginCandidates?batch=1`, post());
    await f(`${ORIGIN}/api/trpc/auth.login?batch=1`, post());
    await f(`${ORIGIN}/api/trpc/auth.refresh?batch=1`, post());
    assert.equal(calls[0]!.headers[HEADER], 'boot-secret');
    assert.equal(calls[1]!.headers[HEADER], 'boot-secret');
    assert.equal(calls[2]!.headers[HEADER], undefined);
    assert.equal(calls[3]!.headers[HEADER], undefined);
  });

  it('overrides a caller-supplied capability header and strips it elsewhere', async () => {
    const { server, calls } = fakeServer();
    const f = createLocalAuthFetch(() => server, ORIGIN);
    await f(`${ORIGIN}/api/trpc/auth.pinLogin`, post({ [HEADER]: 'forged' }));
    await f(`${ORIGIN}/api/trpc/auth.login`, post({ [HEADER]: 'forged' }));
    assert.equal(calls[0]!.headers[HEADER], 'boot-secret');
    assert.equal(calls[1]!.headers[HEADER], undefined);
  });

  it('still rejects non-allowlisted paths, origins and methods', async () => {
    const { server, calls } = fakeServer();
    const f = createLocalAuthFetch(() => server, ORIGIN);
    await assert.rejects(f(`${ORIGIN}/api/trpc/users.list`, post()), /not allowed/);
    await assert.rejects(f(`${ORIGIN}/api/trpc/auth.pinLoginX`, post()), /not allowed/);
    await assert.rejects(f(`${ORIGIN}/api/trpc/auth.pinLogin`, { method: 'GET' }), /not allowed/);
    await assert.rejects(f('http://evil.example/api/trpc/auth.pinLogin', post()), /not allowed/);
    assert.equal(calls.length, 0);
  });
});
