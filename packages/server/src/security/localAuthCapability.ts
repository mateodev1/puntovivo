/**
 * Per-boot capability proving a request came from the embedding desktop
 * launcher through the in-process transport (`app.inject`). It is never sent
 * over a real socket, so Hub clients and standalone web cannot present it.
 * Never log the token.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { throwServerError } from '../lib/errorCodes.js';
import type { Context } from '../trpc/context.js';

export const LOCAL_AUTH_CAPABILITY_HEADER = 'x-puntovivo-local-auth';

export interface LocalAuthCapability {
  token: string;
  matches(header: string | string[] | undefined): boolean;
}

export function createLocalAuthCapability(): LocalAuthCapability {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token, 'utf8');
  return {
    token,
    matches(header) {
      if (typeof header !== 'string') return false;
      const received = Buffer.from(header, 'utf8');
      if (received.length !== expected.length) return false;
      return timingSafeEqual(received, expected);
    },
  };
}

export function assertLocalAuthCapability(ctx: Pick<Context, 'req'>): void {
  const capability = ctx.req.server.localAuthCapability;
  if (!capability.matches(ctx.req.headers[LOCAL_AUTH_CAPABILITY_HEADER])) {
    throwServerError({
      trpcCode: 'UNAUTHORIZED',
      errorCode: 'AUTH_PIN_LOGIN_UNAVAILABLE',
      message: 'PIN login is only available from the desktop launcher',
    });
  }
}
