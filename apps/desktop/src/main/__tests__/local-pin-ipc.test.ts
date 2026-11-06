import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPinIpcHandlers } from '../ipc/local-pin-ipc.ts';
import { createTrustedMainFrameSenderCheck } from '../session/trusted-sender.ts';
import type { HubAuthSession } from '../session/hub-auth-session.ts';

function fixture(options: { withSession?: boolean } = {}) {
  const frame = { url: 'puntovivo-app://app/index.html#/login' };
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: frame };
  const calls: string[] = [];
  const session = {
    pinLoginCandidates: async () => {
      calls.push('candidates');
      return [{ id: 'u1', name: 'Ana' }];
    },
    pinLogin: async (input: { userId: string; pin: string }) => {
      calls.push(`login:${input.userId}:${input.pin}`);
      return { token: 'token' };
    },
  } as unknown as HubAuthSession;
  const isTrustedSender = createTrustedMainFrameSenderCheck({
    getMainWindow: () => window,
    isDev: false,
    webDevServerUrl: 'http://localhost:3000',
  });
  const handlers = createLocalPinIpcHandlers({
    getLocalAuthSession: () => (options.withSession === false ? undefined : session),
    isTrustedSender,
  });
  return { frame, sender, window, event, calls, handlers };
}

test('trusted main-frame sender reaches PIN candidates and PIN login', async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers.candidates(f.event), {
    ok: true,
    data: [{ id: 'u1', name: 'Ana' }],
  });
  assert.deepEqual(await f.handlers.login(f.event, { userId: 'u1', pin: '1234' }), {
    ok: true,
    data: { token: 'token' },
  });
  assert.deepEqual(f.calls, ['candidates', 'login:u1:1234']);
});

for (const mode of ['auxiliary', 'subframe', 'navigated', 'destroyed sender'] as const) {
  test(`refuses PIN IPC from a ${mode} sender before touching the session`, async () => {
    const f = fixture();
    if (mode === 'auxiliary') f.event.sender = { ...f.sender };
    if (mode === 'subframe') f.event.senderFrame = { ...f.frame };
    if (mode === 'navigated') f.frame.url = 'https://attacker.example/';
    if (mode === 'destroyed sender') f.sender.isDestroyed = () => true;
    for (const result of [
      await f.handlers.candidates(f.event),
      await f.handlers.login(f.event, { userId: 'u1', pin: '1234' }),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error.errorCode, 'AUTH_PIN_LOGIN_UNAVAILABLE');
    }
    assert.deepEqual(f.calls, []);
  });
}

test('rejects malformed PIN login input and a missing local session', async () => {
  const f = fixture();
  for (const input of [null, { userId: 'u1', pin: '123456' }, { userId: '', pin: '1234' }]) {
    const result = await f.handlers.login(f.event, input);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(f.calls, []);
  const none = fixture({ withSession: false });
  assert.equal((await none.handlers.candidates(none.event)).ok, false);
});
