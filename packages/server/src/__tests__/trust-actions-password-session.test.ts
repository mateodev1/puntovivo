/**
 * Trust and secret admin actions require a password session. A `staff_pin`
 * session (staff switch or desktop PIN login) proves only a 4-digit secret, so
 * it must not pair devices, toggle entitlements, mint webhook secrets, grant
 * pharmacy authority or rewrite payment credentials, even for an admin.
 */
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

function context(authMethod?: 'staff_pin'): Context {
  const ctx = freshCriticalContext({
    db,
    serverApp: server.app,
    tenantId,
    userId: adminId,
    email: 'trust-admin@example.test',
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

type Call = (caller: ReturnType<typeof appRouter.createCaller>) => Promise<unknown>;

async function settle(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

function isPasswordRequired(error: unknown) {
  return (
    error instanceof TRPCError &&
    error.code === 'FORBIDDEN' &&
    (error.cause as { errorCode?: string } | undefined)?.errorCode ===
      'AUTH_PASSWORD_SESSION_REQUIRED'
  );
}

const procedures: Array<[string, Call]> = [
  [
    'authority.createPairingCode',
    c => c.authority.createPairingCode({ siteId, deviceName: 'Trust till' }),
  ],
  ['authority.revokeDevice', c => c.authority.revokeDevice({ deviceId: 'missing-device-id' })],
  ['modules.setActive', c => c.modules.setActive({ moduleId: 'loyalty', enabled: true })],
  ['modules.applyPreset', c => c.modules.applyPreset({ presetId: 'restaurant' as never })],
  [
    'events.createSubscription',
    c =>
      c.events.createSubscription({
        name: 'Hook',
        destinationUrl: 'https://example.com/hook',
        eventTypes: ['sale.completed' as never],
      }),
  ],
  ['events.revokeSubscription', c => c.events.revokeSubscription({ id: 'missing-sub' })],
  ['events.retryDelivery', c => c.events.retryDelivery({ outboxId: 'missing-outbox' })],
  [
    'pharmacy.createAuthorization',
    c =>
      c.pharmacy.createAuthorization({
        userId: adminId,
        countryCode: 'CO',
        credentialType: 'pharmacist-license',
        credential: 'LIC-12345',
        validFrom: '2026-01-01',
      } as never),
  ],
  [
    'pharmacy.revokeAuthorization',
    c => c.pharmacy.revokeAuthorization({ id: 'missing-auth', reason: 'No longer valid' }),
  ],
  [
    'paymentSettings.updateRail',
    c => c.paymentSettings.updateRail({ railId: 'wompi', credentials: { publicKey: 'pub_x' } }),
  ],
];

describe('trust and secret admin actions require a password session', () => {
  beforeAll(async () => {
    server = await createServer({ dbPath: ':memory:', verbose: false });
    db = getDatabase();
    const seeded = db.select({ tenantId: users.tenantId }).from(users).get();
    if (!seeded) throw new Error('Expected seeded user');
    tenantId = seeded.tenantId;
    siteId = db.select({ id: sites.id }).from(sites).where(eq(sites.tenantId, tenantId)).get()!.id;
    adminId = nanoid();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: adminId,
      tenantId,
      email: 'trust-admin@example.test',
      name: 'Trust Admin',
      passwordHash: 'x',
      role: 'admin',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    deviceId = (
      await registerDevice(db, { tenantId, userId: adminId, kind: 'web', name: 'trust-session' })
    ).deviceId;
  });

  afterAll(async () => {
    await server.close();
  });

  describe.each(procedures)('%s', (_name, call) => {
    it('refuses a PIN session', async () => {
      const error = await settle(call(appRouter.createCaller(context('staff_pin'))));
      expect(isPasswordRequired(error)).toBe(true);
    });

    it('does not refuse a password session for the session method', async () => {
      const error = await settle(call(appRouter.createCaller(context())));
      expect(isPasswordRequired(error)).toBe(false);
    });
  });
});
