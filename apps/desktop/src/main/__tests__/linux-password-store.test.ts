import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveLinuxPasswordStore } from '../linux-password-store.ts';

describe('resolveLinuxPasswordStore', () => {
  it('selects libsecret on a desktop Chromium does not recognise', () => {
    assert.equal(
      resolveLinuxPasswordStore({
        platform: 'linux',
        currentDesktop: 'Hyprland',
        hasPasswordStoreSwitch: false,
      }),
      'gnome-libsecret'
    );
  });

  it('selects libsecret when no desktop is reported', () => {
    assert.equal(
      resolveLinuxPasswordStore({
        platform: 'linux',
        currentDesktop: undefined,
        hasPasswordStoreSwitch: false,
      }),
      'gnome-libsecret'
    );
  });

  it('keeps Chromium detection on recognised desktops', () => {
    for (const currentDesktop of ['GNOME', 'ubuntu:GNOME', 'KDE', 'X-Cinnamon:Cinnamon', 'XFCE']) {
      assert.equal(
        resolveLinuxPasswordStore({
          platform: 'linux',
          currentDesktop,
          hasPasswordStoreSwitch: false,
        }),
        null,
        currentDesktop
      );
    }
  });

  it('respects an explicit --password-store switch', () => {
    assert.equal(
      resolveLinuxPasswordStore({
        platform: 'linux',
        currentDesktop: 'Hyprland',
        hasPasswordStoreSwitch: true,
      }),
      null
    );
  });

  it('never applies outside Linux', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      assert.equal(
        resolveLinuxPasswordStore({
          platform,
          currentDesktop: undefined,
          hasPasswordStoreSwitch: false,
        }),
        null
      );
    }
  });
});
