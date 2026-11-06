/**
 * Renderer sender guard for privileged local IPC (first-use setup claim,
 * desktop PIN login). Only the main window's own top frame, still showing the
 * packaged app (or the configured loopback dev server), may invoke them.
 * Object identity with the main window's `webContents` is intentional: no
 * renderer-supplied id is trusted.
 *
 * @module main/session/trusted-sender
 */

/** Structural Electron-free sender shape. */
export interface TrustedSender {
  isDestroyed: () => boolean;
  mainFrame: { url: string };
}
/** Minimal main-window handle. */
export interface TrustedWindow {
  isDestroyed: () => boolean;
  webContents: TrustedSender;
}
/** Invoking frame and sender identities supplied by Electron, never by renderer input. */
export interface TrustedSenderEvent {
  sender: TrustedSender;
  senderFrame: { url: string } | null;
}
export interface TrustedSenderDependencies {
  getMainWindow: () => TrustedWindow | null;
  isDev: boolean;
  webDevServerUrl: string;
}

function trustedOrigin(url: string, options: TrustedSenderDependencies): boolean {
  try {
    const target = new URL(url);
    if (!options.isDev) {
      return (
        target.protocol === 'puntovivo-app:' &&
        target.hostname === 'app' &&
        target.port === '' &&
        target.username === '' &&
        target.password === '' &&
        target.pathname === '/index.html'
      );
    }
    const expected = new URL(options.webDevServerUrl);
    return (
      ['http:', 'https:'].includes(expected.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname) &&
      target.origin === expected.origin &&
      target.username === '' &&
      target.password === ''
    );
  } catch {
    return false;
  }
}

export function createTrustedMainFrameSenderCheck(options: TrustedSenderDependencies) {
  return (event: TrustedSenderEvent): boolean => {
    const window = options.getMainWindow();
    return Boolean(
      window &&
      !window.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      trustedOrigin(event.sender.mainFrame.url, options)
    );
  };
}
