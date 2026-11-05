/**
 * Shared staff PIN lockout: five consecutive failures lock a user's PIN across
 * staff switching and manager approvals until a successful PIN, a password
 * login, or an admin PIN reset clears the counter.
 */
import { hash } from 'argon2';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type PuntovivoServer } from '../index.js';
import { getDatabase, type DatabaseInstance } from '../db/index.js';
import { sites, users } from '../db/schema.js';
import { hashStaffPin } from '../security/staffPins.js';
import { __resetForTests as resetLoginRateLimit } from '../security/loginRateLimit.js';
import { PIN_LOCKOUT_THRESHOLD } from '../security/pinLockout.js';
import { registerDevice } from '../services/devices/devicesService.js';
import { appRouter } from '../trpc/router.js';
import { freshCriticalContext } from './utils/criticalCommandFixture.js';

// Lets a test run code right after a real Argon2 verify resolves, i.e. at the
// point where concurrent failures from other requests could have landed.
const afterVerify = vi.hoisted(() => ({ hook: null as null | (() => void) }));
vi.mock('../security/staffPins.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../security/staffPins.js')>();
  return {
    ...actual,
    verifyStaffPin: async (hash: string, pin: string) => {
      const result = await actual.verifyStaffPin(hash, pin);
      afterVerify.hook?.();
      return result;
    },
  };
});

const PASSWORD = 'LockoutPass123!';

let server: PuntovivoServer;
let db: DatabaseInstance;
let tenantId: string;
let siteId: string;

type Role = 'admin' | 'manager' | 'cashier';

async function createUser(role: Role, pin: string | null) {
  const id = nanoid();
  const email = `lockout-${role}-${id}@example.test`.toLowerCase();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    tenantId,
    email,
    name: `Lockout ${role}`,
    passwordHash: await hash(PASSWORD),
    staffPinHash: pin ? await hashStaffPin(pin) : null,
    role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  const registration = await registerDevice(db, {
    tenantId,
    userId: id,
    kind: 'web',
    name: `pin-lockout-${role}`,
  });
  return {
    id,
    email,
    ctx() {
      const ctx = freshCriticalContext({
        db,
        serverApp: server.app,
        tenantId,
        userId: id,
        email,
        role,
        siteId,
        deviceId: registration.deviceId,
      });
      (ctx.req as unknown as { ip: string }).ip = '127.0.0.1';
      return ctx;
    },
  };
}

function attempts(userId: string): number {
  return db.select({ n: users.pinFailedAttempts }).from(users).where(eq(users.id, userId)).get()!.n;
}

async function expectCode(promise: Promise<unknown>, errorCode: string) {
  await expect(promise).rejects.toMatchObject({ cause: expect.objectContaining({ errorCode }) });
}

describe('shared PIN lockout', () => {
  beforeAll(async () => {
    server = await createServer({ dbPath: ':memory:', verbose: false });
    db = getDatabase();
    const seeded = db.select({ tenantId: users.tenantId }).from(users).get();
    if (!seeded) throw new Error('Expected seeded user');
    tenantId = seeded.tenantId;
    const site = db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, tenantId)).get();
    if (!site) throw new Error('Expected seeded site');
    siteId = site.id;
  });

  afterAll(async () => {
    await server.close();
  });

  // Window throttles are an independent, shorter-lived control; the lock must
  // hold after they have decayed, so tests clear them to simulate that.
  beforeEach(() => {
    resetLoginRateLimit(db);
  });

  async function wrongSwitches(
    actor: Awaited<ReturnType<typeof createUser>>,
    targetId: string,
    n: number
  ) {
    for (let i = 0; i < n; i += 1) {
      await expectCode(
        appRouter
          .createCaller(actor.ctx())
          .auth.switchStaff({ targetUserId: targetId, pin: '0000' }),
        'AUTH_STAFF_PIN_INVALID'
      );
    }
  }

  it('locks after five wrong PINs via switchStaff', async () => {
    const actor = await createUser('admin', null);
    const cashier = await createUser('cashier', '2468');
    await wrongSwitches(actor, cashier.id, PIN_LOCKOUT_THRESHOLD);
    expect(attempts(cashier.id)).toBe(PIN_LOCKOUT_THRESHOLD);
    resetLoginRateLimit(db);

    await expectCode(
      appRouter
        .createCaller(actor.ctx())
        .auth.switchStaff({ targetUserId: cashier.id, pin: '2468' }),
      'AUTH_PIN_LOCKED'
    );
    // A wrong PIN against a locked user is reported as locked too.
    await expectCode(
      appRouter
        .createCaller(actor.ctx())
        .auth.switchStaff({ targetUserId: cashier.id, pin: '1111' }),
      'AUTH_PIN_LOCKED'
    );
    expect(attempts(cashier.id)).toBe(PIN_LOCKOUT_THRESHOLD);
  });

  async function requestApproval(requester: Awaited<ReturnType<typeof createUser>>) {
    return appRouter.createCaller(requester.ctx()).managerApprovals.request({
      action: 'credit_sale',
      reason: 'Approval needed',
      resourceType: 'sale',
      resourceId: nanoid(),
      summary: { label: 'Sensitive action', amount: 125, currencyCode: 'USD' },
    });
  }

  function decide(
    requester: Awaited<ReturnType<typeof createUser>>,
    requestId: string,
    approverId: string,
    pin: string
  ) {
    return appRouter.createCaller(requester.ctx()).managerApprovals.decideWithPin({
      requestId,
      approverId,
      pin,
      decision: 'approved',
    });
  }

  // Only managers/admins can approve and only cashiers can be switch targets,
  // so one account cannot fail through both doors today. Both doors share the
  // same users.pin_failed_attempts column and helpers; the approval door is
  // covered here, the switch door above.
  it('locks after five wrong PINs via manager approvals', async () => {
    const requester = await createUser('cashier', '2468');
    const approver = await createUser('manager', '8642');
    const request = await requestApproval(requester);
    for (let i = 0; i < PIN_LOCKOUT_THRESHOLD; i += 1) {
      await expectCode(
        decide(requester, request.id, approver.id, '0000'),
        'MANAGER_APPROVAL_PIN_INVALID'
      );
    }
    expect(attempts(approver.id)).toBe(PIN_LOCKOUT_THRESHOLD);
    resetLoginRateLimit(db);
    await expectCode(decide(requester, request.id, approver.id, '8642'), 'AUTH_PIN_LOCKED');
  });

  it('approval failures accumulate and a correct approval PIN resets them', async () => {
    const requester = await createUser('cashier', '2468');
    const approver = await createUser('manager', '8642');
    const request = await requestApproval(requester);
    for (let i = 0; i < 3; i += 1) {
      await expectCode(
        decide(requester, request.id, approver.id, '0000'),
        'MANAGER_APPROVAL_PIN_INVALID'
      );
    }
    expect(attempts(approver.id)).toBe(3);
    await expect(decide(requester, request.id, approver.id, '8642')).resolves.toMatchObject({
      status: 'approved',
    });
    expect(attempts(approver.id)).toBe(0);
  });

  it('successful PIN resets the counter', async () => {
    // A successful switch rebinds the actor's device, so use one admin
    // (device) per successful switch.
    const actor = await createUser('admin', null);
    const secondActor = await createUser('admin', null);
    const cashier = await createUser('cashier', '2468');
    await wrongSwitches(actor, cashier.id, 4);
    await appRouter
      .createCaller(actor.ctx())
      .auth.switchStaff({ targetUserId: cashier.id, pin: '2468' });
    expect(attempts(cashier.id)).toBe(0);
    resetLoginRateLimit(db);
    await wrongSwitches(secondActor, cashier.id, 4);
    resetLoginRateLimit(db);
    await expect(
      appRouter
        .createCaller(secondActor.ctx())
        .auth.switchStaff({ targetUserId: cashier.id, pin: '2468' })
    ).resolves.toMatchObject({ user: { id: cashier.id } });
  });

  it('resets failures on password login', async () => {
    const actor = await createUser('admin', null);
    const cashier = await createUser('cashier', '2468');
    await wrongSwitches(actor, cashier.id, PIN_LOCKOUT_THRESHOLD);
    resetLoginRateLimit(db);
    await appRouter
      .createCaller(cashier.ctx())
      .auth.login({ email: cashier.email, password: PASSWORD });
    expect(attempts(cashier.id)).toBe(0);
    await expect(
      appRouter
        .createCaller(actor.ctx())
        .auth.switchStaff({ targetUserId: cashier.id, pin: '2468' })
    ).resolves.toMatchObject({ user: { id: cashier.id } });
  });

  it('admin setStaffPin resets the counter', async () => {
    const actor = await createUser('admin', null);
    const cashier = await createUser('cashier', '2468');
    await wrongSwitches(actor, cashier.id, PIN_LOCKOUT_THRESHOLD);
    resetLoginRateLimit(db);
    await appRouter.createCaller(actor.ctx()).users.setStaffPin({ id: cashier.id, pin: '1357' });
    expect(attempts(cashier.id)).toBe(0);
    await expect(
      appRouter
        .createCaller(actor.ctx())
        .auth.switchStaff({ targetUserId: cashier.id, pin: '1357' })
    ).resolves.toMatchObject({ user: { id: cashier.id } });
  });

  it('refuses a correct PIN whose lock state went stale during the Argon2 await', async () => {
    const actor = await createUser('admin', null);
    const cashier = await createUser('cashier', '2468');
    // The request snapshots 0 failures, then five concurrent wrong guesses land
    // while its own verify is still in flight.
    afterVerify.hook = () => {
      afterVerify.hook = null;
      db.update(users)
        .set({ pinFailedAttempts: PIN_LOCKOUT_THRESHOLD })
        .where(eq(users.id, cashier.id))
        .run();
    };
    try {
      await expectCode(
        appRouter
          .createCaller(actor.ctx())
          .auth.switchStaff({ targetUserId: cashier.id, pin: '2468' }),
        'AUTH_PIN_LOCKED'
      );
    } finally {
      afterVerify.hook = null;
    }
    expect(attempts(cashier.id)).toBe(PIN_LOCKOUT_THRESHOLD);
  });

  it('same stale-snapshot guard applies to manager approvals', async () => {
    const requester = await createUser('cashier', '2468');
    const approver = await createUser('manager', '8642');
    const request = await requestApproval(requester);
    afterVerify.hook = () => {
      afterVerify.hook = null;
      db.update(users)
        .set({ pinFailedAttempts: PIN_LOCKOUT_THRESHOLD })
        .where(eq(users.id, approver.id))
        .run();
    };
    try {
      await expectCode(decide(requester, request.id, approver.id, '8642'), 'AUTH_PIN_LOCKED');
    } finally {
      afterVerify.hook = null;
    }
    expect(attempts(approver.id)).toBe(PIN_LOCKOUT_THRESHOLD);
  });

  it('parallel guesses never leave a locked account with a granted session', async () => {
    const cashier = await createUser('cashier', '2468');
    const actors = await Promise.all(
      Array.from({ length: PIN_LOCKOUT_THRESHOLD + 1 }, () => createUser('admin', null))
    );
    const results = await Promise.all(
      actors.map((a, i) =>
        appRouter
          .createCaller(a.ctx())
          .auth.switchStaff({
            targetUserId: cashier.id,
            pin: i === PIN_LOCKOUT_THRESHOLD ? '2468' : '0000',
          })
          .then(
            () => 'ok',
            e => (e as { cause?: { errorCode?: string } }).cause?.errorCode ?? 'fail'
          )
      )
    );
    // Whatever the interleaving, a refusal for the right PIN must be a lock,
    // and the counter is never above what the failures recorded.
    expect(['ok', 'AUTH_PIN_LOCKED']).toContain(results[PIN_LOCKOUT_THRESHOLD]);
    expect(attempts(cashier.id)).toBeLessThanOrEqual(PIN_LOCKOUT_THRESHOLD);
  });
});
