/**
 * Chromium picks the Linux safeStorage backend from XDG_CURRENT_DESKTOP. On a
 * desktop it does not recognise (Hyprland, Sway, i3, ...) it falls back to
 * `basic_text` even when a Secret Service such as gnome-keyring is running,
 * and Puntovivo refuses to seal its SQLCipher key in that backend — so the
 * register cannot boot. The flag cannot be left to the launcher either: an
 * AppImage relaunched by the auto-updater loses any command-line switch.
 *
 * @module main/linux-password-store
 */

// Desktops Chromium already maps to libsecret or KWallet on its own.
const RECOGNISED_DESKTOPS = new Set([
  'gnome',
  'unity',
  'cinnamon',
  'pantheon',
  'xfce',
  'ukui',
  'deepin',
  'kde',
]);

export interface PasswordStoreInput {
  platform: NodeJS.Platform;
  currentDesktop: string | undefined;
  hasPasswordStoreSwitch: boolean;
}

/** The `--password-store` value to append, or null to keep Chromium's choice. */
export function resolveLinuxPasswordStore(input: PasswordStoreInput): string | null {
  if (input.platform !== 'linux' || input.hasPasswordStoreSwitch) return null;
  const desktops = (input.currentDesktop ?? '')
    .split(':')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
  if (desktops.some(desktop => RECOGNISED_DESKTOPS.has(desktop))) return null;
  return 'gnome-libsecret';
}
