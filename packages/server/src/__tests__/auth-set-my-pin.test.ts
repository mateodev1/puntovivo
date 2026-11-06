/**
 * `auth.setMyPin`: current-password-gated self-service PIN set/clear.
 */
import { hash } from 'argon2';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase, type DatabaseInstance } from '../db/index.js';
import { auditLogs, sites, users } from '../db/schema.js';
import { hashStaffPin, verifyStaffPin } from '../security/staffPins.js';
import { __resetForTests as resetLoginRateLimit } from '../security/loginRateLimit.js';
import { PIN_LOCKOUT_THRESHOLD } from '../security/pinLockout.js';
import { registerDevice } from '../services/devices/devicesService.js';
import { appRouter } from '../trpc/router.js';
import { freshCriticalContext } from './utils/criticalCommandFixture.js';

const PASSWORD = 'SetMyPinPass123!';

let server: PuntovivoServer;
let db: DatabaseInstance;
let tenantId: string;
let siteId: string;

async function createUser(pin: string | null) {
  const id = nanoid();
  const email = `set-my-pin-${id}@example.test`.toLowerCase();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    tenantId,
    email,
    name: `Self ${id}`,
    passwordHash: await hash(PASSWORD),
    staffPinHash: pin ? await hashStaffPin(pin) : null,
    role: 'cashier',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return { id, email };
}

async function callerFor(user: { id: string; email: string }) {
  const registration = await registerDevice(db, {
    tenantId,
    userId: user.id,
    kind: 'web',
    name: `set-my-pin-${user.id}`,
  });
  const ctx = freshCriticalContext({
    db,
    serverApp: server.app,
    tenantId,
    userId: user.id,
    email: user.email,
    role: 'cashier',
    siteId,
    deviceId: registration.deviceId,
  });
  (ctx.req as unknown as { ip: string }).ip = '127.0.0.1';
  return appRouter.createCaller(ctx);
}

function row(userId: string) {
  return db.select().from(users).where(eq(users.id, userId)).get()!;
}

describe('auth.setMyPin', () => {
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

  it('sets own PIN with correct password', async () => {
    const user = await createUser(null);
    const before = row(user.id).sessionVersion;
    const result = await (
      await callerFor(user)
    ).auth.setMyPin({
      currentPassword: PASSWORD,
      pin: '4821',
    });
    expect(result).toEqual({ ok: true });
    const after = row(user.id);
    expect(after.staffPinHash).toBeTruthy();
    expect(await verifyStaffPin(after.staffPinHash!, '4821')).toBe(true);
    expect(after.sessionVersion).toBe(before);

    const audit = db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, user.id), eq(auditLogs.action, 'user.pin.update')))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(user.id);
    expect(JSON.stringify(audit[0])).not.toContain('4821');
    expect(JSON.stringify(audit[0])).not.toContain(after.staffPinHash!);
  });

  it('rejects wrong password and counts toward the username login bucket', async () => {
    const user = await createUser('1357');
    const caller = await callerFor(user);
    await expect(
      caller.auth.setMyPin({ currentPassword: 'WrongPassword1!', pin: '4821' })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ errorCode: 'AUTH_INVALID_CREDENTIALS' }),
    });
    expect(await verifyStaffPin(row(user.id).staffPinHash!, '1357')).toBe(true);

    // Repeated wrong passwords eventually trip the username bucket.
    let lastCode: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      try {
        await caller.auth.setMyPin({ currentPassword: 'WrongPassword1!', pin: '4821' });
      } catch (e) {
        lastCode = (e as { cause?: { errorCode?: string } }).cause?.errorCode;
        if (lastCode !== 'AUTH_INVALID_CREDENTIALS') break;
      }
    }
    expect(lastCode).not.toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('clears PIN with null', async () => {
    const user = await createUser('1357');
    const result = await (
      await callerFor(user)
    ).auth.setMyPin({
      currentPassword: PASSWORD,
      pin: null,
    });
    expect(result).toEqual({ ok: true });
    expect(row(user.id).staffPinHash).toBeNull();
  });

  it('unlocks a locked PIN', async () => {
    const user = await createUser('1357');
    db.update(users)
      .set({ pinFailedAttempts: PIN_LOCKOUT_THRESHOLD })
      .where(eq(users.id, user.id))
      .run();
    await (await callerFor(user)).auth.setMyPin({ currentPassword: PASSWORD, pin: '9753' });
    const after = row(user.id);
    expect(after.pinFailedAttempts).toBe(0);
    expect(await verifyStaffPin(after.staffPinHash!, '9753')).toBe(true);
  });

  it('rejects malformed PINs', async () => {
    const user = await createUser(null);
    await expect(
      (await callerFor(user)).auth.setMyPin({ currentPassword: PASSWORD, pin: '12ab' })
    ).rejects.toThrow();
  });
});
