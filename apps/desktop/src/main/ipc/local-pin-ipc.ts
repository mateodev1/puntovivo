/**
 * Desktop PIN login IPC handlers. Electron-free so they can be unit tested;
 * `session-ipc.ts` binds them to `ipcMain`. Both handlers refuse any sender
 * other than the main window's top frame (same guard as the setup claim)
 * before touching the local auth session.
 *
 * @module main/ipc/local-pin-ipc
 */

import {
  captureHubAuthIpc,
  HubAuthRemoteError,
  type HubAuthSession,
  type HubPinLoginInput,
} from '../session/hub-auth-session.ts';
import type { TrustedSenderEvent } from '../session/trusted-sender.js';

export interface LocalPinIpcDependencies {
  getLocalAuthSession: () => HubAuthSession | undefined;
  isTrustedSender: (event: TrustedSenderEvent) => boolean;
}

function parsePinLoginInput(input: unknown): HubPinLoginInput {
  if (!input || typeof input !== 'object') throw new Error('PIN login input is invalid');
  const { userId, pin } = input as { userId?: unknown; pin?: unknown };
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) {
    throw new Error('PIN login input is invalid');
  }
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw new Error('PIN login input is invalid');
  }
  return { userId, pin };
}

export function createLocalPinIpcHandlers(deps: LocalPinIpcDependencies) {
  function requireSession(event: TrustedSenderEvent): HubAuthSession {
    if (!deps.isTrustedSender(event)) {
      throw new HubAuthRemoteError({
        message: 'PIN login is unavailable',
        errorCode: 'AUTH_PIN_LOGIN_UNAVAILABLE',
        status: 403,
      });
    }
    const session = deps.getLocalAuthSession();
    if (!session) throw new Error('Local desktop authentication is unavailable');
    return session;
  }

  return {
    candidates: (event: TrustedSenderEvent) =>
      captureHubAuthIpc(async () => requireSession(event).pinLoginCandidates()),
    login: (event: TrustedSenderEvent, input: unknown) =>
      captureHubAuthIpc(async () => {
        const session = requireSession(event);
        return session.pinLogin(parsePinLoginInput(input));
      }),
  };
}
