/**
 * Auth router — write procedures ( split).
 *
 * `login` / `refresh` (publicProcedure — pre-auth, rate-limited), `logout` /
 * `changePassword` (protected / critical-command), and `registerDevice`
 * (tenant). The public-vs-protected boundary is carried by
 * each procedure's builder, preserved verbatim. , ADR-0002.
 *
 * @module trpc/routers/auth/mutations
 */
import { z } from 'zod';
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { publicProcedure } from '../../init.js';
import { protectedProcedure } from '../../middleware/auth.js';
import { tenantProcedure } from '../../middleware/tenant.js';
import { criticalCommandProcedure } from '../../middleware/criticalCommand.js';
import { asCriticalCommandContext } from '../../middleware/commandEnvelope.js';
import { cashierManagerOrAdminProcedure } from '../../middleware/roles.js';
import { devices, users, tenants } from '../../../db/schema.js';
import {
  loginInput,
  changePasswordInput,
  switchStaffInput,
  pinLoginInput,
  setMyPinInput,
  validatePasswordStrength,
} from '../../schemas/auth.js';
import { throwServerError } from '../../../lib/errorCodes.js';
import {
  findActiveDevice,
  registerDevice as registerDeviceService,
} from '../../../services/devices/devicesService.js';
import {
  assertTenantSite,
  claimPairingCodeForDevice,
  inferAuthorityRole,
} from '../../../services/devices/authority.js';
import { getCurrentSchemaVersion } from '../../../lib/runtimeMetadata.js';
import {
  clearRefreshCookie,
  createStaffPinSessionClaims,
  getAuthSessionClaims,
  REFRESH_COOKIE_NAME,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../../security/authTokens.js';
import {
  checkIp as checkLoginIp,
  checkStaffPin,
  checkUsername as checkLoginUsername,
  registerFailure as registerLoginFailure,
  registerStaffPinFailure,
  registerStaffPinSuccess,
  registerSuccess as registerLoginSuccess,
} from '../../../security/loginRateLimit.js';
import {
  getDummyPasswordHash,
  hashPasswordSecurely,
  needsRehash,
  verifyPasswordSecurely,
} from '../../../security/passwords.js';
import {
  createRefreshFamily,
  pruneExpiredRefreshFamilies,
  revokeRefreshFamiliesForUser,
  rotateRefreshFamily,
} from '../../../security/refreshTokenFamilies.js';
import { rateLimitFor } from '../../middleware/procedureRateLimit.js';
import { setRefreshCookie } from './helpers.js';
import {
  consumePinSuccess,
  isPinLocked,
  PIN_LOCKOUT_THRESHOLD,
  registerPinFailure,
  resetPinFailures,
  throwPinLocked,
} from '../../../security/pinLockout.js';
import { getDummyStaffPinHash, hashStaffPin, verifyStaffPin } from '../../../security/staffPins.js';
import { enqueueSync } from '../../../services/sync/enqueue.js';
import { writeAuditLog } from '../../../services/audit-logs.js';
import { parkDraftsForIdentityChange } from '../../../application/sales/parkDraftsForIdentityChange.js';
import { assertLocalAuthCapability } from '../../../security/localAuthCapability.js';
import type { Context } from '../../context.js';
import { DEVICE_ID_HEADER } from '../../schemas/envelope.js';

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function requireIdentityChangeDevice(ctx: {
  db: Parameters<typeof findActiveDevice>[0];
  tenantId: string;
  req: { headers: Record<string, string | string[] | undefined> };
}): Promise<string> {
  const requestedDeviceId = readHeader(ctx.req.headers[DEVICE_ID_HEADER]);
  if (!requestedDeviceId) {
    throwServerError({
      trpcCode: 'BAD_REQUEST',
      errorCode: 'DEVICE_NOT_REGISTERED',
      message: 'x-device-id header is required before switching staff',
    });
  }
  const device = await findActiveDevice(ctx.db, {
    tenantId: ctx.tenantId,
    deviceId: requestedDeviceId,
  });
  if (!device) {
    throwServerError({
      trpcCode: 'BAD_REQUEST',
      errorCode: 'DEVICE_NOT_REGISTERED',
      message: 'Device is missing, inactive, or belongs to another tenant',
      details: { deviceId: requestedDeviceId },
    });
  }
  return device.id;
}

/** Per-user PIN-login throttle bucket (stored in the `username` kind). */
function pinLoginBucketKey(userId: string): string {
  return `pin:${userId}`;
}

/** PIN-login IP bucket, kept apart from the password-login IP bucket. */
function pinLoginIpKey(ip: string): string {
  return `pin-ip:${ip}`;
}

type SessionUser = typeof users.$inferSelect;
type SessionTenant = typeof tenants.$inferSelect;
type SessionContext = Pick<Context, 'db' | 'req' | 'res'>;

/**
 * Shared tail of `auth.login` / `auth.pinLogin`: start a refresh family, sign
 * both tokens, set the refresh cookie and build the response. When `gate` is
 * given, it runs inside the same immediate transaction as the family creation,
 * so a refusal (throw) rolls the whole session grant back.
 */
function issueSession(
  ctx: SessionContext,
  user: SessionUser,
  tenant: SessionTenant,
  sessionClaims?: ReturnType<typeof createStaffPinSessionClaims>,
  gate?: (tx: typeof ctx.db) => void
) {
  pruneExpiredRefreshFamilies(ctx.db);
  const family = gate
    ? ctx.db.transaction(
        tx => {
          gate(tx as unknown as typeof ctx.db);
          return createRefreshFamily(tx, { tenantId: user.tenantId, userId: user.id });
        },
        { behavior: 'immediate' }
      )
    : createRefreshFamily(ctx.db, { tenantId: user.tenantId, userId: user.id });

  const token = signAccessToken(ctx.req.server, user, sessionClaims);
  const refreshToken = signRefreshToken(ctx.req.server, user, family, sessionClaims);
  setRefreshCookie(ctx.req, ctx.res, refreshToken);

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
    },
  };
}

export const authMutationProcedures = {
  /**
   * switch a shared terminal to another active cashier without
   * exposing manager/admin privilege through a low-entropy PIN.
   */
  switchStaff: cashierManagerOrAdminProcedure
    .input(switchStaffInput)
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.user!;
      const rateIdentity = {
        tenantId: ctx.tenantId,
        actorUserId: actor.id,
        targetUserId: input.targetUserId,
      };
      checkStaffPin(ctx.db, rateIdentity);

      const target = await ctx.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, input.targetUserId),
            eq(users.tenantId, ctx.tenantId),
            eq(users.role, 'cashier'),
            eq(users.isActive, true)
          )
        )
        .get();

      const verificationHash = target?.staffPinHash ?? (await getDummyStaffPinHash());
      const pinMatches = await verifyStaffPin(verificationHash, input.pin);
      const lockable = Boolean(target?.staffPinHash) && target?.id !== actor.id;
      if (lockable && isPinLocked(target!)) {
        throwPinLocked();
      }
      if (!target?.staffPinHash || !pinMatches || target.id === actor.id) {
        registerStaffPinFailure(ctx.db, rateIdentity);
        if (lockable) registerPinFailure(ctx.db, target!.id);
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_STAFF_PIN_INVALID',
          message: 'Cashier or PIN is invalid',
        });
      }

      // Staff handoff clears only this terminal's renderer workspace. Bind the
      // parking transaction to the validated device header so another live
      // register using the same cashier keeps its own active cart.
      const deviceId = await requireIdentityChangeDevice(ctx);

      pruneExpiredRefreshFamilies(ctx.db);
      const sessionClaims = createStaffPinSessionClaims();
      const handoff = ctx.db.transaction(
        tx => {
          const currentActor = tx
            .select({ sessionVersion: users.sessionVersion, isActive: users.isActive })
            .from(users)
            .where(and(eq(users.id, actor.id), eq(users.tenantId, ctx.tenantId)))
            .get();
          const currentTarget = tx
            .select()
            .from(users)
            .where(and(eq(users.id, target.id), eq(users.tenantId, ctx.tenantId)))
            .get();
          if (
            !currentActor?.isActive ||
            (typeof actor.sessionVersion === 'number' &&
              currentActor.sessionVersion !== actor.sessionVersion) ||
            !currentTarget?.isActive ||
            currentTarget.role !== 'cashier' ||
            currentTarget.staffPinHash !== target.staffPinHash
          ) {
            throwServerError({
              trpcCode: 'UNAUTHORIZED',
              errorCode: 'AUTH_IDENTITY_CHANGED',
              message: 'A user session or staff authorization changed during handoff',
            });
          }
          const currentDeviceIdentity = tx
            .select({
              activeUserId: devices.activeUserId,
              identityVersion: devices.identityVersion,
              isActive: devices.isActive,
            })
            .from(devices)
            .where(and(eq(devices.id, deviceId), eq(devices.tenantId, ctx.tenantId)))
            .get();
          if (
            !currentDeviceIdentity?.isActive ||
            (currentDeviceIdentity.activeUserId !== null &&
              currentDeviceIdentity.activeUserId !== actor.id)
          ) {
            throwServerError({
              trpcCode: 'UNAUTHORIZED',
              errorCode: 'AUTH_IDENTITY_CHANGED',
              message: 'The active user for this device changed before staff handoff completed',
            });
          }
          // Atomic lock gate: a concurrent request may have locked the PIN
          // while we awaited Argon2. Refusing here rolls the handoff back.
          if (!consumePinSuccess(tx as unknown as typeof ctx.db, target.id)) {
            throwPinLocked();
          }
          parkDraftsForIdentityChange(tx as unknown as typeof ctx.db, {
            tenantId: ctx.tenantId,
            actorId: actor.id,
            reason: 'staff_switch',
            deviceId,
            now: new Date().toISOString(),
          });
          const rebound = tx
            .update(devices)
            .set({
              activeUserId: target.id,
              identityVersion: currentDeviceIdentity.identityVersion + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(devices.id, deviceId),
                eq(devices.tenantId, ctx.tenantId),
                eq(devices.isActive, true),
                eq(devices.identityVersion, currentDeviceIdentity.identityVersion)
              )
            )
            .run();
          if (rebound.changes !== 1) {
            throwServerError({
              trpcCode: 'UNAUTHORIZED',
              errorCode: 'AUTH_IDENTITY_CHANGED',
              message: 'The active user for this device changed during staff handoff',
            });
          }
          const createdFamily = createRefreshFamily(tx, {
            tenantId: currentTarget.tenantId,
            userId: currentTarget.id,
          });
          writeAuditLog({
            tx,
            tenantId: ctx.tenantId,
            actorId: actor.id,
            action: 'auth.staff_switch',
            resourceType: 'cashier',
            resourceId: target.id,
            before: { userId: actor.id, role: actor.role },
            after: { userId: target.id, role: target.role },
            metadata: {
              authMethod: sessionClaims.authMethod,
              sessionExpiresAt: new Date(sessionClaims.authSessionExpiresAt!).toISOString(),
            },
          });
          return { family: createdFamily, target: currentTarget };
        },
        { behavior: 'immediate' }
      );
      // Clear failures only after the refresh family and audit transaction
      // commits. A failed switch must not grant brute-force amnesty.
      registerStaffPinSuccess(ctx.db, rateIdentity);

      const token = signAccessToken(ctx.req.server, handoff.target, sessionClaims);
      const refreshToken = signRefreshToken(
        ctx.req.server,
        handoff.target,
        handoff.family,
        sessionClaims
      );
      setRefreshCookie(ctx.req, ctx.res, refreshToken);

      return {
        token,
        user: {
          id: handoff.target.id,
          email: handoff.target.email,
          name: handoff.target.name,
          role: handoff.target.role,
          tenantId: handoff.target.tenantId,
        },
        sessionExpiresAt: new Date(sessionClaims.authSessionExpiresAt!).toISOString(),
      };
    }),

  /**
   * Login with email and password.
   *
   * dual rate-limit gate runs BEFORE the credential check:
   *
   * - per-IP bucket: 10 attempts per 60s from a single origin. Stops
   * local brute-force.
   * - per-username bucket: 5 failed attempts per 15 minutes against one
   * email, counted even when the user does not exist (prevents
   * enumeration via timing + 404-style responses). Stops credential
   * stuffing that rotates IPs to target one account.
   *
   * Both buckets increment on every unauthorized branch. A successful
   * login resets the username bucket; the IP bucket decays via TTL so a
   * single legitimate login does not amnesty an active attack source.
   *
   * The global @fastify/rate-limit plugin at `/api/trpc/*` (100/min)
   * stays as a backstop for the rest of the tRPC surface.
   */
  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    const { email, password } = input;
    const ip = ctx.req.ip;

    // /  — refuse before any DB work when the buckets are
    // saturated. Since  the buckets are DB-backed so a server restart
    // no longer wipes mid-attack state; pass `ctx.db` through on every call.
    checkLoginIp(ctx.db, ip);
    checkLoginUsername(ctx.db, email);

    // Find user by email
    const user = await ctx.db.select().from(users).where(eq(users.email, email)).get();

    if (!user) {
      // equalise login timing. Burn roughly one Argon2 verify on
      // the not-found branch against a cached dummy hash so an attacker
      // cannot enumerate accounts by measuring response time. The result
      // is intentionally ignored; the surrounding error is still raised.
      const dummyHash = await getDummyPasswordHash();
      await verifyPasswordSecurely(dummyHash, password);
      registerLoginFailure(ctx.db, ip, email);
      throwServerError({
        trpcCode: 'UNAUTHORIZED',
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
      });
    }

    // Verify password (wrapped helper pins Argon2 params).
    // The verify runs BEFORE the `isActive` check so a disabled-account
    // probe pays the same Argon2 cost as the not-found probe. Without
    // this re-ordering, an attacker could distinguish "user exists but
    // is disabled" from "user does not exist" via response timing.
    const isValidPassword = await verifyPasswordSecurely(user.passwordHash, password);
    if (!isValidPassword) {
      registerLoginFailure(ctx.db, ip, email);
      throwServerError({
        trpcCode: 'UNAUTHORIZED',
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
      });
    }

    // Check if user is active (after the password verify so the
    // disabled-account branch carries the same latency profile).
    if (!user.isActive) {
      registerLoginFailure(ctx.db, ip, email);
      throwServerError({
        trpcCode: 'UNAUTHORIZED',
        errorCode: 'AUTH_USER_DISABLED',
        message: 'Your account has been disabled. Please contact an administrator.',
      });
    }

    // Get tenant info
    const tenant = await ctx.db.select().from(tenants).where(eq(tenants.id, user.tenantId)).get();

    if (!tenant || !tenant.isActive) {
      registerLoginFailure(ctx.db, ip, email);
      throwServerError({
        trpcCode: 'UNAUTHORIZED',
        errorCode: 'AUTH_TENANT_DISABLED',
        message: 'Your organization has been disabled. Please contact support.',
      });
    }

    // clear the username bucket after every field cleared. A password
    // sign-in also unlocks the PIN at once: reset the lockout counter AND the
    // `pin:${id}` PIN-login throttle bucket.
    registerLoginSuccess(ctx.db, email);
    registerLoginSuccess(ctx.db, pinLoginBucketKey(user.id));
    resetPinFailures(ctx.db, user.id);

    // lazy rehash: if the stored hash was produced with
    // weaker Argon2 params (or a legacy library default), upgrade it
    // now while we have the plaintext. Failure of the rehash itself
    // must never block a valid login — it is best-effort hardening.
    if (needsRehash(user.passwordHash)) {
      try {
        const upgradedHash = await hashPasswordSecurely(password);
        await ctx.db
          .update(users)
          .set({ passwordHash: upgradedHash, updatedAt: new Date().toISOString() })
          .where(eq(users.id, user.id));
      } catch {
        // Swallow — the user is already authenticated; the next login
        // will retry the rehash.
      }
    }

    // Auditoría 2026-07 — refresh rotation: each login starts a token
    // family so `auth.refresh` can detect replay of rotated tokens.
    // Login is also the low-frequency hook for pruning expired families.
    return issueSession(ctx, user, tenant);
  }),

  /**
   * Users offered on the desktop PIN login screen. Local-only: refused unless
   * the request carries the per-boot desktop capability. Locked users are
   * hidden so the picker never offers a PIN that would be refused.
   */
  pinLoginCandidates: publicProcedure.mutation(async ({ ctx }) => {
    assertLocalAuthCapability(ctx);
    return ctx.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(
        and(
          eq(users.isActive, true),
          eq(tenants.isActive, true),
          isNotNull(users.staffPinHash),
          lt(users.pinFailedAttempts, PIN_LOCKOUT_THRESHOLD)
        )
      )
      .orderBy(asc(users.name))
      .all();
  }),

  /**
   * Desktop-only 4-digit PIN login. Order mirrors `switchStaff`: capability,
   * rate limits, Argon2 verify (dummy hash when there is nothing to verify
   * against), lock/failure handling, then the success grant inside one
   * immediate transaction guarded by `consumePinSuccess`.
   */
  pinLogin: publicProcedure.input(pinLoginInput).mutation(async ({ ctx, input }) => {
    assertLocalAuthCapability(ctx);
    // PIN attempts use their own IP bucket so wrong PINs can never block the
    // password sign-in that unlocks them.
    const ip = pinLoginIpKey(ctx.req.ip);
    const bucketKey = pinLoginBucketKey(input.userId);
    checkLoginIp(ctx.db, ip);
    checkLoginUsername(ctx.db, bucketKey);

    const user = await ctx.db.select().from(users).where(eq(users.id, input.userId)).get();
    const tenant = user
      ? await ctx.db.select().from(tenants).where(eq(tenants.id, user.tenantId)).get()
      : undefined;

    const eligible = Boolean(user?.isActive && tenant?.isActive && user?.staffPinHash);
    const verificationHash =
      (eligible ? user!.staffPinHash : null) ?? (await getDummyStaffPinHash());
    const pinMatches = await verifyStaffPin(verificationHash, input.pin);

    if (eligible && isPinLocked(user!)) {
      throwPinLocked();
    }
    if (!eligible || !pinMatches) {
      registerLoginFailure(ctx.db, ip, bucketKey);
      if (eligible) registerPinFailure(ctx.db, user!.id);
      throwServerError({
        trpcCode: 'UNAUTHORIZED',
        errorCode: 'AUTH_STAFF_PIN_INVALID',
        message: 'User or PIN is invalid',
      });
    }

    const sessionClaims = createStaffPinSessionClaims();
    const session = issueSession(ctx, user!, tenant!, sessionClaims, tx => {
      // Re-read inside the transaction: the user may have been disabled or had
      // the PIN changed while Argon2 was running.
      const current = tx.select().from(users).where(eq(users.id, user!.id)).get();
      if (!current?.isActive || current.staffPinHash !== user!.staffPinHash) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_STAFF_PIN_INVALID',
          message: 'User or PIN is invalid',
        });
      }
      // Atomic lock gate: concurrent guesses may have locked the PIN while we
      // awaited Argon2. Refusing here rolls the session grant back.
      if (!consumePinSuccess(tx, user!.id)) {
        throwPinLocked();
      }
      writeAuditLog({
        tx,
        tenantId: user!.tenantId,
        actorId: user!.id,
        action: 'auth.pin_login',
        resourceType: 'user',
        resourceId: user!.id,
        before: null,
        after: { userId: user!.id, role: user!.role },
        metadata: {
          authMethod: sessionClaims.authMethod,
          sessionExpiresAt: new Date(sessionClaims.authSessionExpiresAt!).toISOString(),
        },
      });
    });
    registerLoginSuccess(ctx.db, bucketKey);
    return session;
  }),

  /**
   * Logout — invalidates every outstanding access token issued for
   * the current user by bumping `users.sessionVersion`. The next
   * call to `verifyAccessToken` (or `verifyRefreshToken`) for that
   * user rejects any pre-logout token because the recorded
   * `sessionVersion` no longer matches the JWT payload.
   *
   * Promoted from `publicProcedure` to `protectedProcedure` in
   * vector 4: only an authenticated caller can sign their
   * own session out, and the `ctx.user.id` we need for the bump
   * comes from the validated JWT.
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    ctx.db.transaction(
      tx => {
        const now = new Date().toISOString();
        parkDraftsForIdentityChange(tx as unknown as typeof ctx.db, {
          tenantId: ctx.user.tenantId,
          actorId: ctx.user.id,
          reason: 'logout',
          now,
        });
        tx.update(devices)
          .set({
            activeUserId: null,
            identityVersion: sql`${devices.identityVersion} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(devices.tenantId, ctx.user.tenantId),
              eq(devices.activeUserId, ctx.user.id),
              eq(devices.isActive, true)
            )
          )
          .run();
        tx.update(users)
          .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
          .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.user.tenantId)))
          .run();
        // The sessionVersion bump already invalidates every refresh JWT;
        // dropping the family rows keeps the table free of dead sessions.
        revokeRefreshFamiliesForUser(tx as unknown as typeof ctx.db, ctx.user.id);
      },
      { behavior: 'immediate' }
    );
    clearRefreshCookie(ctx.req, ctx.res);
    return { success: true, message: 'Logged out successfully' };
  }),

  /**
   * Refresh the JWT token.  — per-IP cap of 30/min to blunt
   * refresh-storm probing without affecting normal session lifecycles
   * (a renderer refreshes every ~14 minutes against the 15-min access
   * token TTL).
   */
  refresh: publicProcedure
    .use(rateLimitFor({ name: 'auth.refresh', max: 30, windowMs: 60_000, keyBy: ['ip'] }))
    .mutation(async ({ ctx }) => {
      const refreshPayload = await verifyRefreshToken(ctx.req);
      if (!refreshPayload) {
        // An invalid, expired, or checkout-stale cookie is still reported as
        // an incident on this first rejection, but it must not remain in the
        // browser and generate the same incident on every application boot.
        if (typeof ctx.req.cookies[REFRESH_COOKIE_NAME] === 'string') {
          clearRefreshCookie(ctx.req, ctx.res);
        }
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_REFRESH_INVALID',
          message: 'Refresh session is invalid or missing',
        });
      }

      // Verify user still exists and is active
      const user = await ctx.db
        .select()
        .from(users)
        .where(eq(users.id, refreshPayload.userId))
        .get();

      if (!user || !user.isActive) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_USER_DISABLED',
          message: 'User not found or disabled',
        });
      }

      // Auditoría 2026-07 — rotation with replay detection. A verified
      // token whose jti was already rotated away (outside the grace window)
      // is a stolen copy: the rotate call revoked the family and bumped
      // sessionVersion, so we clear the cookie and reject. A `reissued`
      // result is a benign concurrent refresh (two tabs sharing the cookie)
      // and is handed the family's current jti. Tokens without a familyId
      // were signed before this feature — accept once and upgrade into a
      // fresh family (the grace closes itself when those tokens age out at
      // 7 days).
      let family: { familyId: string; jti: string };
      if (refreshPayload.familyId && refreshPayload.jti) {
        const rotation = rotateRefreshFamily(ctx.db, {
          familyId: refreshPayload.familyId,
          presentedJti: refreshPayload.jti,
          userId: user.id,
        });
        if (rotation.status !== 'rotated' && rotation.status !== 'reissued') {
          clearRefreshCookie(ctx.req, ctx.res);
          throwServerError({
            trpcCode: 'UNAUTHORIZED',
            errorCode: 'AUTH_REFRESH_INVALID',
            message: 'Refresh session is invalid or missing',
          });
        }
        family = { familyId: rotation.familyId, jti: rotation.jti };
      } else {
        family = createRefreshFamily(ctx.db, {
          tenantId: user.tenantId,
          userId: user.id,
        });
      }

      const sessionClaims = getAuthSessionClaims(refreshPayload);
      const token = signAccessToken(ctx.req.server, user, sessionClaims);
      const refreshToken = signRefreshToken(ctx.req.server, user, family, sessionClaims);
      setRefreshCookie(ctx.req, ctx.res, refreshToken);

      return { token };
    }),

  /**
   * Self-service staff PIN set/clear, gated by the current password. A wrong
   * password counts toward the same per-email login bucket as `auth.login`, so
   * this cannot be used to brute-force the password. Like the admin
   * `users.setStaffPin`, it does not bump `sessionVersion` and resets the PIN
   * lockout counter.
   */
  setMyPin: protectedProcedure
    .use(
      rateLimitFor({
        name: 'auth.setMyPin',
        max: 20,
        windowMs: 60 * 60_000,
        keyBy: ['userId'],
      })
    )
    .input(setMyPinInput)
    .mutation(async ({ ctx, input }) => {
      const actorId = ctx.user.id;
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_INVALID_CREDENTIALS',
          message: 'authenticated context required',
        });
      }
      const user = await ctx.db
        .select()
        .from(users)
        .where(and(eq(users.id, actorId), eq(users.tenantId, tenantId)))
        .get();
      if (!user || !user.isActive) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_INVALID_CREDENTIALS',
          message: 'authenticated context required',
        });
      }

      const ip = ctx.req.ip;
      checkLoginUsername(ctx.db, user.email);
      const passwordOk = await verifyPasswordSecurely(user.passwordHash, input.currentPassword);
      if (!passwordOk) {
        registerLoginFailure(ctx.db, ip, user.email);
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_INVALID_CREDENTIALS',
          message: 'Current password is incorrect',
        });
      }

      const wasConfigured = user.staffPinHash !== null;
      const willBeConfigured = input.pin !== null;
      const staffPinHash = input.pin === null ? null : await hashStaffPin(input.pin);
      const now = new Date().toISOString();
      ctx.db.transaction(tx => {
        tx.update(users)
          .set({ staffPinHash, pinFailedAttempts: 0, updatedAt: now })
          .where(and(eq(users.id, actorId), eq(users.tenantId, tenantId)))
          .run();
        writeAuditLog({
          tx,
          tenantId: tenantId,
          actorId,
          action: 'user.pin.update',
          resourceType: 'user',
          resourceId: actorId,
          before: { configured: wasConfigured },
          after: { configured: willBeConfigured },
          metadata: { targetRole: user.role, self: true },
        });
      });

      await enqueueSync(
        { ...ctx, tenantId },
        {
          entityType: 'users',
          entityId: actorId,
          operation: 'update',
          data: { id: actorId, staffPinUpdated: true, updatedAt: now },
        }
      );

      return { ok: true as const };
    }),

  /**
   * Change password for current user.
   *
   * wrapped with `criticalCommandProcedure` (ADR-0002).
   * Caller must include the `x-device-id` header (after registering
   * via `auth.registerDevice`) and a fresh `x-puntovivo-envelope`
   * JSON header per request. Replays with the same idempotency key
   * return the cached result; mismatched payload hash raises
   * `IDEMPOTENCY_KEY_CONFLICT`.
   */
  changePassword: criticalCommandProcedure
    .use(
      rateLimitFor({
        name: 'auth.changePassword',
        max: 5,
        windowMs: 15 * 60_000,
        keyBy: ['userId'],
      })
    )
    .input(changePasswordInput)
    .mutation(async ({ ctx, input }) => {
      const commandContext = asCriticalCommandContext(ctx);
      const { currentPassword, newPassword } = input;

      // Defensive narrowing — the criticalCommandProcedure chain
      // already requires an authenticated tenant context, but tRPC
      // type inference loses the `ctx.user` narrowing across our
      // envelope middleware's bespoke return shape. Cheap belt-and-
      // suspenders so the rest of the body can dereference cleanly.
      if (!ctx.user) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_INVALID_CREDENTIALS',
          message: 'authenticated context required',
        });
      }
      const actorId = ctx.user.id;

      // Validate password strength
      const validation = validatePasswordStrength(newPassword);
      if (!validation.valid) {
        throwServerError({
          trpcCode: 'BAD_REQUEST',
          errorCode: 'AUTH_PASSWORD_POLICY',
          message: `Password does not meet security requirements: ${validation.errors.join(', ')}`,
          details: { errors: validation.errors },
        });
      }

      // Get user
      const user = await ctx.db.select().from(users).where(eq(users.id, actorId)).get();

      if (!user) {
        throwServerError({
          trpcCode: 'NOT_FOUND',
          errorCode: 'AUTH_USER_NOT_FOUND',
          message: 'User not found',
        });
      }

      // Verify current password (pinned Argon2 params).
      const isValidPassword = await verifyPasswordSecurely(user.passwordHash, currentPassword);
      if (!isValidPassword) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_CURRENT_PASSWORD_INCORRECT',
          message: 'Current password is incorrect',
        });
      }

      // Hash new password (pinned Argon2 params).
      const newPasswordHash = await hashPasswordSecurely(newPassword);

      const result = { success: true, message: 'Password changed successfully' };
      ctx.db.transaction(
        tx => {
          const current = tx
            .select({
              passwordHash: users.passwordHash,
              sessionVersion: users.sessionVersion,
              isActive: users.isActive,
            })
            .from(users)
            .where(and(eq(users.id, actorId), eq(users.tenantId, ctx.tenantId)))
            .get();
          if (
            !current?.isActive ||
            current.passwordHash !== user.passwordHash ||
            (typeof ctx.user!.sessionVersion === 'number' &&
              current.sessionVersion !== ctx.user!.sessionVersion)
          ) {
            throwServerError({
              trpcCode: 'UNAUTHORIZED',
              errorCode: 'AUTH_IDENTITY_CHANGED',
              message: 'The authenticated user changed while updating the password',
            });
          }

          // Validate the captured terminal generation while the old session
          // version is still current. The subsequent mutations share this
          // same writer transaction, so no identity handoff can interleave.
          commandContext.completeInTransaction(tx as unknown as typeof ctx.db, result);
          const now = new Date().toISOString();
          parkDraftsForIdentityChange(tx as unknown as typeof ctx.db, {
            tenantId: ctx.tenantId,
            actorId,
            reason: 'password_change',
            now,
          });
          tx.update(devices)
            .set({
              activeUserId: null,
              identityVersion: sql`${devices.identityVersion} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(devices.tenantId, ctx.tenantId),
                eq(devices.activeUserId, actorId),
                eq(devices.isActive, true)
              )
            )
            .run();
          const updated = tx
            .update(users)
            .set({
              passwordHash: newPasswordHash,
              sessionVersion: sql`${users.sessionVersion} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(users.id, actorId),
                eq(users.tenantId, ctx.tenantId),
                eq(users.sessionVersion, current.sessionVersion)
              )
            )
            .run();
          if (updated.changes !== 1) {
            throwServerError({
              trpcCode: 'UNAUTHORIZED',
              errorCode: 'AUTH_IDENTITY_CHANGED',
              message: 'The authenticated user changed during password update',
            });
          }
          revokeRefreshFamiliesForUser(tx as unknown as typeof ctx.db, actorId);
        },
        { behavior: 'immediate' }
      );
      clearRefreshCookie(ctx.req, ctx.res);

      return result;
    }),

  /**
   * Register a device with the active tenant. Idempotent
   * when an existing active device id is supplied. Returns the
   * server-issued (or echoed) device id; the renderer persists it
   * locally (Electron userData file or browser localStorage) and
   * sends it as `x-device-id` on every critical mutation.
   *
   * Skipped on read queries and catalog mutations (per ADR-0002);
   * called once after `auth.login` succeeds.
   */
  registerDevice: tenantProcedure
    .use(
      // cap pairing-flow registration at 10/hour per IP. The
      // legitimate flow registers once per device install; bursts above
      // that indicate enumeration or pairing-code probing.
      rateLimitFor({
        name: 'auth.registerDevice',
        max: 10,
        windowMs: 60 * 60_000,
        keyBy: ['ip'],
      })
    )
    .input(
      z.object({
        // `hub_client` discriminates a cashier terminal
        // whose renderer points at a remote Store Hub. Stays in
        // lockstep with the `devices.kind` enum in db/schema.ts.
        kind: z.enum(['desktop', 'web', 'hub_client']),
        name: z.string().min(1).max(120),
        deviceId: z.string().min(8).max(64).optional(),
        siteId: z.string().min(1).optional(),
        pairingCode: z.string().min(4).max(32).optional(),
        appVersion: z.string().min(1).max(80).nullable().optional(),
        dbSchemaVersion: z.number().int().nonnegative().nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // tenantProcedure already narrows ctx.user via protectedProcedure;
      // the explicit narrowing here is defensive against TS inference
      // edge-cases when extending the auth router (mirrors the pattern
      // used elsewhere in this file).
      if (!ctx.user || !ctx.tenantId) {
        throwServerError({
          trpcCode: 'UNAUTHORIZED',
          errorCode: 'AUTH_INVALID_CREDENTIALS',
          message: 'authenticated tenant context required',
        });
      }
      if (input.siteId) {
        await assertTenantSite(ctx.db, ctx.tenantId, input.siteId);
      }
      const result = await registerDeviceService(ctx.db, {
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
        kind: input.kind,
        name: input.name,
        deviceId: input.deviceId,
        authorityRole: inferAuthorityRole(input.kind),
        pairedSiteId: input.siteId ?? null,
        appVersion: input.appVersion ?? null,
        dbSchemaVersion: input.dbSchemaVersion ?? getCurrentSchemaVersion(ctx.db),
        metadata: input.metadata,
      });
      if (input.pairingCode) {
        await claimPairingCodeForDevice(ctx.db, {
          tenantId: ctx.tenantId,
          code: input.pairingCode,
          deviceId: result.deviceId,
          actorUserId: ctx.user.id,
        });
      }
      return result;
    }),
};
