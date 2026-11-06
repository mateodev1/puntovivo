import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetRuntimeConfigCacheForTests } from '@/lib/runtimeConfigClient';
import {
  isPackagedLocalAuth,
  isPinLoginAvailable,
  loginLocal,
  pinLoginCandidatesLocal,
  pinLoginLocal,
  refreshLocal,
} from './localDesktopAuthTransport';

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRuntimeConfigCacheForTests();
});

describe('packaged local desktop authentication', () => {
  it('uses the sealed main-process credential only for the packaged local origin', async () => {
    const login = vi.fn().mockResolvedValue({ ok: true, data: { token: 'access-one' } });
    const refresh = vi.fn().mockResolvedValue({ ok: true, data: { token: 'access-two' } });
    vi.stubGlobal('window', {
      location: { protocol: 'puntovivo-app:' },
      api: { session: { loginLocal: login, refreshLocal: refresh } },
    });
    expect(isPackagedLocalAuth()).toBe(true);
    expect(await loginLocal({ email: 'admin@example.test', password: 'password' })).toEqual({
      token: 'access-one',
    });
    expect(await refreshLocal()).toEqual({ token: 'access-two' });
    expect(login).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not take the packaged path in a normal browser', () => {
    expect(isPackagedLocalAuth()).toBe(false);
  });
});

describe('PIN login bridge', () => {
  const stub = (protocol: string, session: Record<string, unknown>) =>
    vi.stubGlobal('window', { location: { protocol }, api: { session } });

  it('is available only when packaged and both bridge functions exist', () => {
    const fns = { pinLoginCandidatesLocal: vi.fn(), pinLoginLocal: vi.fn() };
    stub('puntovivo-app:', fns);
    expect(isPinLoginAvailable()).toBe(true);
    stub('puntovivo-app:', { pinLoginLocal: fns.pinLoginLocal });
    expect(isPinLoginAvailable()).toBe(false);
    stub('http:', fns);
    expect(isPinLoginAvailable()).toBe(false);
  });

  it('unwraps candidates and grants, surfacing error codes', async () => {
    stub('puntovivo-app:', {
      pinLoginCandidatesLocal: vi
        .fn()
        .mockResolvedValue({ ok: true, data: [{ id: 'u', name: 'N' }] }),
      pinLoginLocal: vi.fn().mockResolvedValue({
        ok: false,
        error: { message: 'locked', errorCode: 'AUTH_PIN_LOCKED' },
      }),
    });
    expect(await pinLoginCandidatesLocal()).toEqual([{ id: 'u', name: 'N' }]);
    await expect(pinLoginLocal({ userId: 'u', pin: '1234' })).rejects.toMatchObject({
      data: { errorCode: 'AUTH_PIN_LOCKED' },
    });
  });
});
