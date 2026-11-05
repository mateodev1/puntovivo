/**
 * `passwordSessionRequired` — refuses `staff_pin` sessions.
 *
 * A staff switch or desktop PIN login proves only a 4-digit secret. Such a
 * session may run the till, but it must not mint credentials or change
 * privileges (create users, edit roles, reset passwords, set other users'
 * PINs): that would let a guessed or shoulder-surfed PIN escalate into a
 * permanent password takeover. Chain it BEFORE `commandEnvelope` so cached
 * replays are refused too (see `criticalCommand.ts`).
 *
 * @module trpc/middleware/passwordSession
 */

import { middleware } from '../init.js';
import { throwServerError } from '../../lib/errorCodes.js';

export const passwordSessionRequired = middleware(async ({ ctx, next }) => {
  if (ctx.user?.authMethod === 'staff_pin') {
    throwServerError({
      trpcCode: 'FORBIDDEN',
      errorCode: 'AUTH_PASSWORD_SESSION_REQUIRED',
      message: 'Sign in with your password to manage users',
    });
  }
  return next();
});
