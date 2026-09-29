import { getRuntimeConfigSync } from '@/lib/runtimeConfigClient';
import { unwrapHubResult } from './hubAuthTransport';
import type { SessionAPI } from '@/types/electron';

function localSessionApi(): SessionAPI {
  const api = window.api?.session ?? window.session;
  if (!api) throw new Error('Local desktop authentication bridge is unavailable');
  return api;
}

/** Packaged Electron is cross-site to loopback and cannot use Strict refresh cookies. */
export function isPackagedLocalAuth(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.location.protocol === 'puntovivo-app:' &&
    getRuntimeConfigSync().authorityMode !== 'hub_client'
  );
}

export async function loginLocal(input: { email: string; password: string }) {
  const login = localSessionApi().loginLocal;
  if (!login) throw new Error('Local desktop authentication bridge is unavailable');
  return unwrapHubResult(await login(input));
}

export async function refreshLocal() {
  const refresh = localSessionApi().refreshLocal;
  if (!refresh) throw new Error('Local desktop authentication bridge is unavailable');
  return unwrapHubResult(await refresh());
}

export async function switchStaffLocal(input: { targetUserId: string; pin: string }) {
  const switchStaff = localSessionApi().switchStaffLocal;
  if (!switchStaff) throw new Error('Local desktop authentication bridge is unavailable');
  return unwrapHubResult(await switchStaff(input));
}

export async function logoutLocal(): Promise<void> {
  const logout = localSessionApi().logoutLocal;
  if (!logout) throw new Error('Local desktop authentication bridge is unavailable');
  unwrapHubResult(await logout());
}

export async function clearLocal(): Promise<void> {
  const clear = localSessionApi().clearLocal;
  if (!clear) throw new Error('Local desktop authentication bridge is unavailable');
  await clear();
}
