/**
 * Shared staff PIN lockout.
 *
 * A four-digit PIN has only 10,000 values, so the windowed throttles in
 * `loginRateLimit.ts` are not enough on their own: they decay on a timer.
 * This counter lives on the user row (`users.pin_failed_attempts`), is shared
 * by every PIN verification path (PIN login, staff switch, manager approvals)
 * and only clears on a successful PIN, a successful password login, or an
 * admin PIN reset. Once `PIN_LOCKOUT_THRESHOLD` consecutive failures are
 * recorded the PIN is rejected even when correct.
 *
 * Callers must run the Argon2 verify BEFORE consulting `isPinLocked`, so
 * response time does not reveal lock state.
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import type { DatabaseInstance } from '../db/index.js';
import { users } from '../db/schema.js';
import { throwServerError } from '../lib/errorCodes.js';

export const PIN_LOCKOUT_THRESHOLD = 5;

export function isPinLocked(user: { pinFailedAttempts: number }): boolean {
  return user.pinFailedAttempts >= PIN_LOCKOUT_THRESHOLD;
}

/** Atomically count one more consecutive failure. */
export function registerPinFailure(db: DatabaseInstance, userId: string): void {
  db.update(users)
    .set({ pinFailedAttempts: sql`${users.pinFailedAttempts} + 1` })
    .where(eq(users.id, userId))
    .run();
}

/** Unconditionally clear the counter (password login, admin PIN reset). */
export function resetPinFailures(db: DatabaseInstance, userId: string): void {
  db.update(users).set({ pinFailedAttempts: 0 }).where(eq(users.id, userId)).run();
}

/**
 * Atomic success gate for a verified PIN. Clears the counter only while it is
 * still below the threshold; returns false when the user is at/over it, i.e.
 * the PIN got locked while this request was awaiting Argon2 and the caller
 * must refuse with `AUTH_PIN_LOCKED`. Call it inside the same transaction that
 * grants the session/decision so a refusal rolls everything back.
 */
export function consumePinSuccess(db: DatabaseInstance, userId: string): boolean {
  const result = db
    .update(users)
    .set({ pinFailedAttempts: 0 })
    .where(and(eq(users.id, userId), lt(users.pinFailedAttempts, PIN_LOCKOUT_THRESHOLD)))
    .run();
  return result.changes === 1;
}

export function throwPinLocked(): never {
  throwServerError({
    trpcCode: 'FORBIDDEN',
    errorCode: 'AUTH_PIN_LOCKED',
    message: 'PIN is locked after too many failed attempts',
  });
}
