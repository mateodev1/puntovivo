/**
 * User administration requires a password session. A `staff_pin` session
 * (staff switch or desktop PIN login) proves only a 4-digit secret, so it must
 * never mint credentials or change privileges, even for an admin.
 */
import { hash } from 'argon2';
import { nanoid } from 'nanoid';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase, type DatabaseInstance } from '../db/index.js';
import { sites, users } from '../db/schema.js';
import { registerDevice } from '../services/devices/devicesService.js';
import { appRouter } from '../trpc/router.js';
import type { Context } from '../trpc/context.js';
import { freshCriticalContext } from './utils/criticalCommandFixture.js';

let server: PuntovivoServer;
let db: DatabaseInstance;
let tenantId: string;
let siteId: string;
let adminId: string;
let deviceId: string;

async function createUser(role: 'admin' | 'cashier' = 'cashier') {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    tenantId,
    email: `pwd-session-${id}@example.test`.toLowerCase(),
    name: `Pwd ${id}`,
    passwordHash: await hash('PwdSessionPass123!'),
    role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function context(authMethod?: 'staff_pin'): Context {
  const ctx = freshCriticalContext({
    db,
    serverApp: server.app,
    tenantId,
    userId: adminId,
    email: 'pwd-session-admin@example.test',
    role: 'admin',
    siteId,
    deviceId,
  });
  if (authMethod) {
    ctx.user = { ...ctx.user!, authMethod, authSessionExpiresAt: Date.now() + 60_000 };
  }
  (ctx.req as unknown as { ip: string }).ip = '127.0.0.1';
  return ctx;
}

async function expectPasswordSessionRequired(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(TRPCError);
  expect((error as TRPCError).code).toBe('FORBIDDEN');
  expect((error as TRPCError).cause).toMatchObject({
    errorCode: 'AUTH_PASSWORD_SESSION_REQUIRED',
  });
}

describe('user administration requires a password session', () => {
  beforeAll(async () => {
    server = await createServer({ dbPath: ':memory:', verbose: false });
    db = getDatabase();
    const seeded = db.select({ tenantId: users.tenantId }).from(users).get();
    if (!seeded) throw new Error('Expected seeded user');
    tenantId = seeded.tenantId;
    siteId = db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, tenantId)).get()!.id;
    adminId = await createUser('admin');
    deviceId = (
      await registerDevice(db, { tenantId, userId: adminId, kind: 'web', name: 'pwd-session' })
    ).deviceId;
  });

  afterAll(async () => {
    await server.close();
  });

  describe('users.create', () => {
    const input = () => ({
      email: `created-${nanoid()}@example.test`.toLowerCase(),
      name: 'Created',
      password: 'CreatedPass123!',
      role: 'admin' as const,
    });

    it('refuses a PIN session', async () => {
      await expectPasswordSessionRequired(
        appRouter.createCaller(context('staff_pin')).users.create(input())
      );
    });

    it('allows a password session', async () => {
      const created = await appRouter.createCaller(context()).users.create(input());
      expect(created.id).toBeTypeOf('string');
    });
  });

  describe('users.update', () => {
    it('refuses a PIN session', async () => {
      const target = await createUser();
      await expectPasswordSessionRequired(
        appRouter.createCaller(context('staff_pin')).users.update({ id: target, role: 'admin' })
      );
      const row = db.select({ role: users.role }).from(users).where(eq(users.id, target)).get();
      expect(row?.role).toBe('cashier');
    });

    it('allows a password session', async () => {
      const target = await createUser();
      const updated = await appRouter
        .createCaller(context())
        .users.update({ id: target, role: 'manager' });
      expect(updated.role).toBe('manager');
    });
  });

  describe('users.resetPassword', () => {
    it('refuses a PIN session, including on the caller’s own account', async () => {
      const target = await createUser();
      for (const id of [target, adminId]) {
        await expectPasswordSessionRequired(
          appRouter
            .createCaller(context('staff_pin'))
            .users.resetPassword({ id, newPassword: 'ResetPass123!' })
        );
      }
    });

    it('allows a password session', async () => {
      const target = await createUser();
      const reset = await appRouter
        .createCaller(context())
        .users.resetPassword({ id: target, newPassword: 'ResetPass123!' });
      expect(reset.success).toBe(true);
    });
  });

  describe('users.setStaffPin', () => {
    it('refuses a PIN session', async () => {
      const target = await createUser();
      await expectPasswordSessionRequired(
        appRouter.createCaller(context('staff_pin')).users.setStaffPin({ id: target, pin: '2468' })
      );
      const row = db
        .select({ hash: users.staffPinHash })
        .from(users)
        .where(eq(users.id, target))
        .get();
      expect(row?.hash).toBeNull();
    });

    it('allows a password session', async () => {
      const target = await createUser();
      const result = await appRouter
        .createCaller(context())
        .users.setStaffPin({ id: target, pin: '2468' });
      expect(result.hasPin).toBe(true);
    });
  });

  it('users.list stays readable from a PIN session', async () => {
    const list = await appRouter
      .createCaller(context('staff_pin'))
      .users.list({ page: 1, perPage: 5 });
    expect(list.items.length).toBeGreaterThan(0);
  });
});
