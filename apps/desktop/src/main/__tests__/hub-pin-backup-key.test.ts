import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubAuthSession, HUB_AUTH_STATE_FILE } from '../session/hub-auth-session.ts';
import { __resetForTests, register } from '../session/desktopSession.ts';
import { handleGetBackupEncryptionKey } from '../ipc/backup/encryption-key.ts';
import type { SafeStorageLike } from '../db-key-store.ts';
import { makeBackupIpcDeps } from './helpers/backup-ipc-deps.ts';

const TEST_KEY = 'e'.repeat(64);
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => __resetForTests());

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(`sealed:${Buffer.from(plain).toString('base64')}`),
  decryptString: sealed =>
    Buffer.from(sealed.toString().slice('sealed:'.length), 'base64').toString(),
  getSelectedStorageBackend: () => 'gnome_libsecret',
};

const user = { id: 'user-1', email: 'admin@example.test', role: 'admin', tenantId: 'tenant-1' };

// Opaque tokens: the JWT decode fails, so only the explicit PIN marking can
// keep the session from registering as a password session.
function response(data: unknown): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'puntovivo_refresh=r; Path=/; HttpOnly, puntovivo_csrf=c; Path=/');
  return new Response(JSON.stringify([{ result: { data } }]), { status: 200, headers });
}

function makeAuth(replies: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'puntovivo-hub-pin-'));
  dirs.push(dir);
  return createHubAuthSession({
    hubUrl: 'http://127.0.0.1:8090',
    allowInsecureLoopback: true,
    allowPinLogin: true,
    getStatePath: () => join(dir, HUB_AUTH_STATE_FILE),
    safeStorage,
    fetchImpl: (async () => response(replies.shift())) as typeof fetch,
  });
}

async function revealAfterRegister(auth: ReturnType<typeof makeAuth>, token: string) {
  await register(token, auth.verifyAccessToken);
  return handleGetBackupEncryptionKey(
    makeBackupIpcDeps({ resolveDatabaseEncryptionKey: async () => TEST_KEY })
  );
}

describe('hub PIN sessions cannot reveal the backup key', () => {
  it('switchStaff marks the session as PIN even when the token cannot be decoded', async () => {
    const auth = makeAuth([
      { token: 'opaque-1', user },
      { token: 'opaque-2', user, sessionExpiresAt: '2026-09-03T20:00:00.000Z' },
    ]);
    await auth.login({ email: user.email, password: 'secret' });
    await auth.switchStaff({ targetUserId: 'cashier-2', pin: '1234' });
    assert.deepEqual(await revealAfterRegister(auth, 'opaque-2'), {
      success: false,
      error: 'password_session_required',
    });
  });

  it('pinLogin marks the session as PIN even when the token cannot be decoded', async () => {
    const auth = makeAuth([{ token: 'opaque-1', user }]);
    await auth.pinLogin({ userId: 'user-1', pin: '1234' });
    assert.deepEqual(await revealAfterRegister(auth, 'opaque-1'), {
      success: false,
      error: 'password_session_required',
    });
  });

  it('a refresh keeps the PIN marking when the new token carries no authMethod claim', async () => {
    const claims = Buffer.from(
      JSON.stringify({
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: user.email,
        role: 'admin',
        sessionVersion: 3,
      })
    ).toString('base64url');
    const refreshed = `h.${claims}.s`;
    const auth = makeAuth([{ token: 'opaque-1', user }, { token: refreshed }]);
    await auth.pinLogin({ userId: 'user-1', pin: '1234' });
    await auth.refresh();
    assert.deepEqual(await revealAfterRegister(auth, refreshed), {
      success: false,
      error: 'password_session_required',
    });
  });

  it('a password login still reveals the key', async () => {
    const auth = makeAuth([{ token: 'opaque-1', user }]);
    await auth.login({ email: user.email, password: 'secret' });
    assert.deepEqual(await revealAfterRegister(auth, 'opaque-1'), { success: true, key: TEST_KEY });
  });
});
