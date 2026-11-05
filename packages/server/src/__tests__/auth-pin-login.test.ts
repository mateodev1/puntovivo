/**
 * Local-only PIN login: `auth.pinLoginCandidates` and `auth.pinLogin`.
 * Requests go through `app.inject` with the per-boot capability header, the
 * same way the desktop launcher's in-process transport reaches the server.
 */
import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase, type DatabaseInstance } from '../db/index.js';
import { sites, tenants, users } from '../db/schema.js';
import { hashStaffPin } from '../security/staffPins.js';
import { __resetForTests as resetLoginRateLimit } from '../security/loginRateLimit.js';
import { LOCAL_AUTH_CAPABILITY_HEADER } from '../security/localAuthCapability.js';
import { PIN_LOCKOUT_THRESHOLD } from '../security/pinLockout.js';
import { registerDevice } from '../services/devices/devicesService.js';
import { appRouter } from '../trpc/router.js';
import { freshCriticalContext } from './utils/criticalCommandFixture.js';

let server: PuntovivoServer;
let db: DatabaseInstance;
let tenantId: string;
let siteId: string;

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(header) ? header : header ? [header] : [];
  for (const h of headers) {
    const m = h.match(new RegExp(`(?:^|\\s)${name}=([^;]+)`));
    if (m?.[1]) return m[1];
  }
  return null;
}

async function call(procedure: string, input: unknown, withCapability = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (withCapability) headers[LOCAL_AUTH_CAPABILITY_HEADER] = server.getLocalAuthCapability();
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/trpc/auth.${procedure}?batch=1`,
    headers,
    payload: JSON.stringify({ '0': input ?? {} }),
  });
  const body = response.json()[0];
  return {
    response,
    data: body?.result?.data as any,
    errorCode: body?.error?.data?.errorCode ?? body?.error?.json?.data?.errorCode,
  };
}

async function createUser(opts: {
  pin: string | null;
  name?: string;
  role?: 'admin' | 'manager' | 'cashier';
  isActive?: boolean;
  tenant?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    tenantId: opts.tenant ?? tenantId,
    email: `pin-login-${id}@example.test`.toLowerCase(),
    name: opts.name ?? `Pin ${id}`,
    passwordHash: await hash('PinLoginPass123!'),
    staffPinHash: opts.pin ? await hashStaffPin(opts.pin) : null,
    role: opts.role ?? 'cashier',
    isActive: opts.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function attempts(userId: string): number {
  return db.select({ n: users.pinFailedAttempts }).from(users).where(eq(users.id, userId)).get()!.n;
}

describe('auth.pinLogin / auth.pinLoginCandidates', () => {
  beforeAll(async () => {
    server = await createServer({ dbPath: ':memory:', verbose: false });
    db = getDatabase();
    const seeded = db.select({ tenantId: users.tenantId }).from(users).get();
    if (!seeded) throw new Error('Expected seeded user');
    tenantId = seeded.tenantId;
    siteId = db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, tenantId)).get()!.id;
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    resetLoginRateLimit(db);
  });

  it('succeeds with capability and correct PIN, issuing a staff_pin session', async () => {
    const id = await createUser({ pin: '1357' });
    const { response, data } = await call('pinLogin', { userId: id, pin: '1357' });
    expect(response.statusCode).toBe(200);
    expect(data.user.id).toBe(id);
    expect(data.tenant.id).toBe(tenantId);
    const payload = await server.app.jwt.verify<{ authMethod?: string }>(data.token);
    expect(payload.authMethod).toBe('staff_pin');
    expect(cookieValue(response.headers['set-cookie'], 'puntovivo_refresh')).toBeTruthy();
    expect(attempts(id)).toBe(0);
  });

  it('is refused without the capability', async () => {
    const id = await createUser({ pin: '1357' });
    const { errorCode, data } = await call('pinLogin', { userId: id, pin: '1357' }, false);
    expect(errorCode).toBe('AUTH_PIN_LOGIN_UNAVAILABLE');
    expect(data).toBeUndefined();
    expect(attempts(id)).toBe(0);
  });

  it('treats unknown, inactive, inactive-tenant and unenrolled users as invalid', async () => {
    const inactive = await createUser({ pin: '1357', isActive: false });
    const unenrolled = await createUser({ pin: null });
    const otherTenant = nanoid();
    const now = new Date().toISOString();
    await db.insert(tenants).values({
      id: otherTenant,
      name: 'Disabled Tenant',
      slug: `disabled-${otherTenant}`.toLowerCase(),
      isActive: false,
      createdAt: now,
      updatedAt: now,
    } as typeof tenants.$inferInsert);
    const disabledTenantUser = await createUser({ pin: '1357', tenant: otherTenant });
    for (const userId of ['does-not-exist', inactive, unenrolled, disabledTenantUser]) {
      const { errorCode } = await call('pinLogin', { userId, pin: '1357' });
      expect(errorCode).toBe('AUTH_STAFF_PIN_INVALID');
    }
    // Ineligible users never accumulate lockout failures.
    expect(attempts(inactive)).toBe(0);
    expect(attempts(unenrolled)).toBe(0);
  });

  it('counts failures toward the shared lockout, even for the correct PIN afterwards', async () => {
    const id = await createUser({ pin: '2468' });
    for (let i = 0; i < PIN_LOCKOUT_THRESHOLD; i += 1) {
      resetLoginRateLimit(db);
      const { errorCode } = await call('pinLogin', { userId: id, pin: '0000' });
      expect(errorCode).toBe('AUTH_STAFF_PIN_INVALID');
    }
    expect(attempts(id)).toBe(PIN_LOCKOUT_THRESHOLD);
    resetLoginRateLimit(db);
    const locked = await call('pinLogin', { userId: id, pin: '2468' });
    expect(locked.errorCode).toBe('AUTH_PIN_LOCKED');
    expect(locked.data).toBeUndefined();
  });

  it('shares the lockout with auth.switchStaff', async () => {
    const cashier = await createUser({ pin: '2468' });
    const actorId = await createUser({ pin: null, role: 'admin' });
    for (let i = 0; i < PIN_LOCKOUT_THRESHOLD; i += 1) {
      resetLoginRateLimit(db);
      await call('pinLogin', { userId: cashier, pin: '0000' });
    }
    resetLoginRateLimit(db);
    const registration = await registerDevice(db, {
      tenantId,
      userId: actorId,
      kind: 'web',
      name: 'pin-login-shared',
    });
    const ctx = freshCriticalContext({
      db,
      serverApp: server.app,
      tenantId,
      userId: actorId,
      email: 'actor@example.test',
      role: 'admin',
      siteId,
      deviceId: registration.deviceId,
    });
    (ctx.req as unknown as { ip: string }).ip = '127.0.0.1';
    await expect(
      appRouter.createCaller(ctx).auth.switchStaff({ targetUserId: cashier, pin: '2468' })
    ).rejects.toMatchObject({ cause: expect.objectContaining({ errorCode: 'AUTH_PIN_LOCKED' }) });
  });

  it('pinLoginCandidates lists only enrolled, unlocked, active users and requires the capability', async () => {
    const ok = await createUser({ pin: '1111', name: 'Aaa Candidate OK' });
    const noPin = await createUser({ pin: null, name: 'Aaa No Pin' });
    const inactive = await createUser({ pin: '1111', name: 'Aaa Inactive', isActive: false });
    const locked = await createUser({ pin: '1111', name: 'Aaa Locked' });
    db.update(users)
      .set({ pinFailedAttempts: PIN_LOCKOUT_THRESHOLD })
      .where(eq(users.id, locked))
      .run();

    const { data } = await call('pinLoginCandidates', undefined);
    const ids = (data as Array<{ id: string; name: string }>).map(u => u.id);
    expect(ids).toContain(ok);
    for (const excluded of [noPin, inactive, locked]) expect(ids).not.toContain(excluded);
    const names = (data as Array<{ name: string }>).map(u => u.name);
    expect(names).toEqual([...names].sort());
    expect(Object.keys(data[0]).sort()).toEqual(['id', 'name']);

    const refused = await call('pinLoginCandidates', undefined, false);
    expect(refused.errorCode).toBe('AUTH_PIN_LOGIN_UNAVAILABLE');
  });

  it('refresh after pinLogin keeps the 8h session cap', async () => {
    const id = await createUser({ pin: '1357' });
    const login = await call('pinLogin', { userId: id, pin: '1357' });
    const refreshCookie = cookieValue(login.response.headers['set-cookie'], 'puntovivo_refresh')!;
    const csrfCookie = cookieValue(login.response.headers['set-cookie'], 'puntovivo_csrf')!;
    const loginPayload = await server.app.jwt.verify<{ authSessionExpiresAt?: number }>(
      login.data.token
    );
    expect(loginPayload.authSessionExpiresAt).toBeGreaterThan(Date.now());

    const refreshed = await server.app.inject({
      method: 'POST',
      url: '/api/trpc/auth.refresh?batch=1',
      headers: {
        cookie: [`puntovivo_refresh=${refreshCookie}`, `puntovivo_csrf=${csrfCookie}`].join('; '),
        'content-type': 'application/json',
        'x-csrf-token': csrfCookie,
      },
      payload: '{}',
    });
    const token = refreshed.json()[0]?.result?.data?.token as string;
    expect(token).toBeTypeOf('string');
    const payload = await server.app.jwt.verify<{
      authMethod?: string;
      authSessionExpiresAt?: number;
    }>(token);
    expect(payload.authMethod).toBe('staff_pin');
    expect(payload.authSessionExpiresAt).toBe(loginPayload.authSessionExpiresAt);
    const nextRefresh = cookieValue(refreshed.headers['set-cookie'], 'puntovivo_refresh')!;
    const refreshPayload = server.app.jwt.decode<{ authSessionExpiresAt?: number }>(nextRefresh);
    expect(refreshPayload?.authSessionExpiresAt).toBe(loginPayload.authSessionExpiresAt);
  });
});
