/**
 * `passwordSessionRequired` — refuses `staff_pin` sessions.
 *
 * A staff switch or desktop/hub PIN login proves only a 4-digit secret. Such a
 * session may run the till, but it must not change trust or reveal secrets:
 * user administration (create users, edit roles, reset passwords, set PINs),
 * device pairing and revocation, module entitlements, webhook secrets, pharmacy
 * authorizations, payment credentials, and irreversible or bulk actions (data
 * retention, launch-migration imports, site deletion, customer personal-data
 * export and disposal). A guessed or shoulder-surfed PIN must not escalate into
 * a permanent takeover or an unrecoverable change. Chain it BEFORE
 * `commandEnvelope` so cached replays are refused too (see `criticalCommand.ts`).
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
      message: 'Sign in with your password to perform this action',
    });
  }
  return next();
});
