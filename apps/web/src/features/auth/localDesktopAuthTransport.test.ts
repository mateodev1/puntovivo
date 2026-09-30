import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetRuntimeConfigCacheForTests } from '@/lib/runtimeConfigClient';
import { isPackagedLocalAuth, loginLocal, refreshLocal } from './localDesktopAuthTransport';

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
