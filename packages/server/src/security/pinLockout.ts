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

import { eq, sql } from 'drizzle-orm';
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

/** Clear the consecutive-failure counter (no-op write skipped when already 0). */
export function resetPinFailures(db: DatabaseInstance, userId: string): void {
  db.update(users).set({ pinFailedAttempts: 0 }).where(eq(users.id, userId)).run();
}

export function throwPinLocked(): never {
  throwServerError({
    trpcCode: 'FORBIDDEN',
    errorCode: 'AUTH_PIN_LOCKED',
    message: 'PIN is locked after too many failed attempts',
  });
}
