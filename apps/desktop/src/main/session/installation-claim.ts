import { randomBytes } from 'node:crypto';
import type { PuntovivoServer } from '@puntovivo/server';
import {
  createTrustedMainFrameSenderCheck,
  type TrustedSenderEvent,
  type TrustedWindow,
} from './trusted-sender.ts';

/** Runtime-owned handles and trust configuration for the fixed first-use command. */
interface SetupClaimDependencies {
  getMainWindow: () => TrustedWindow | null;
  getServer: () => Pick<PuntovivoServer, 'getSetupToken' | 'app'> | null;
  isHubClient: boolean;
  isDev: boolean;
  webDevServerUrl: string;
}

/** Safe renderer result: no capability, transport detail, or credential crosses this boundary. */
export type InstallationClaimResult = { ok: true } | { ok: false; errorCode: string };

/**
 * The packaged renderer cannot read a localhost CSRF cookie. Keep both the
 * one-use proof and cookie in main, and dispatch the fixed tRPC mutation via
 * Fastify's in-process transport. No general-purpose request proxy is exposed.
 */
export function createInstallationClaimHandler(options: SetupClaimDependencies) {
  const isTrustedSender = createTrustedMainFrameSenderCheck(options);
  return async (event: TrustedSenderEvent, input: unknown): Promise<InstallationClaimResult> => {
    if (options.isHubClient || !isTrustedSender(event)) {
      return { ok: false, errorCode: 'SETUP_LOCAL_ACCESS_REQUIRED' };
    }
    try {
      const server = options.getServer();
      const token = server?.getSetupToken();
      if (!server || !token) return { ok: false, errorCode: 'SETUP_ALREADY_COMPLETED' };
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errorCode: 'VALIDATION_ERROR' };
      }
      const csrf = randomBytes(32).toString('base64url');
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/trpc/auth.completeSetup?batch=1',
        remoteAddress: '127.0.0.1',
        headers: {
          origin: 'puntovivo-app://app',
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        cookies: { puntovivo_csrf: csrf },
        payload: { '0': { ...input, token } },
      });
      const data = response.json()[0];
      if (response.statusCode === 200 && data?.result?.data?.created === true) return { ok: true };
      // Never forward SQL messages, paths, stack traces, secrets or invoke errors.
      const code: unknown = data?.error?.data?.errorCode;
      return {
        ok: false,
        errorCode:
          typeof code === 'string' && /^SETUP_[A-Z_]+$/.test(code)
            ? code
            : response.statusCode === 400
              ? 'VALIDATION_ERROR'
              : 'INTERNAL_SERVER_ERROR',
      };
    } catch {
      return { ok: false, errorCode: 'INTERNAL_SERVER_ERROR' };
    }
  };
}
