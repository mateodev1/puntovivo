import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `electron-forge start` builds the main bundle with Vite in-process, and Vite
// defaults process.env.NODE_ENV to "production" for builds when it is unset.
// The spawned Electron dev process inherits that value, which makes the
// embedded server treat the dev loop as production (and refuse to boot with
// dev verbose logging). forge.config.js must pin the dev default first.
const forgeConfigUrl = new URL('../../../forge.config.js', import.meta.url).href;
const desktopDir = fileURLToPath(new URL('../../../', import.meta.url));

function nodeEnvAfterLoadingForgeConfig(env: NodeJS.ProcessEnv): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(forgeConfigUrl)}); process.stdout.write(String(process.env.NODE_ENV));`,
    ],
    { cwd: desktopDir, env, encoding: 'utf8' }
  );
}

describe('forge.config.js NODE_ENV default', () => {
  it('defaults NODE_ENV to development for the forge dev loop', () => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    assert.equal(nodeEnvAfterLoadingForgeConfig(env), 'development');
  });

  it('keeps an explicitly provided NODE_ENV', () => {
    assert.equal(
      nodeEnvAfterLoadingForgeConfig({ ...process.env, NODE_ENV: 'production' }),
      'production'
    );
  });
});
