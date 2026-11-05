import { describe, expect, it } from 'vitest';
import {
  getDummyStaffPinHash,
  hashStaffPin,
  isValidStaffPin,
  verifyStaffPin,
  warmUpStaffPinSecurity,
} from '../security/staffPins.js';
import { hashPasswordSecurely } from '../security/passwords.js';

describe(' staff PIN security', () => {
  it('accepts exactly four digits and rejects malformed values', () => {
    expect(isValidStaffPin('1234')).toBe(true);
    expect(isValidStaffPin('123')).toBe(false);
    expect(isValidStaffPin('12345')).toBe(false);
    expect(isValidStaffPin('123456')).toBe(false);
    expect(isValidStaffPin('12a4')).toBe(false);
  });

  it('hash from v1 domain does not verify', async () => {
    const legacyHash = await hashPasswordSecurely('puntovivo:staff-pin:v1:1234');
    await expect(verifyStaffPin(legacyHash, '1234')).resolves.toBe(false);
  });

  it('stores a one-way Argon2id hash with domain separation', async () => {
    const hash = await hashStaffPin('1234');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('1234');
    await expect(verifyStaffPin(hash, '1234')).resolves.toBe(true);
    await expect(verifyStaffPin(hash, '4321')).resolves.toBe(false);
  });

  it('rejects invalid PIN shapes before hashing or verification', async () => {
    await expect(hashStaffPin('123')).rejects.toThrow('exactly 4 digits');
    const hash = await hashStaffPin('1234');
    await expect(verifyStaffPin(hash, '123')).resolves.toBe(false);
  });

  it('prewarms and reuses the unavailable-target timing hash', async () => {
    await expect(warmUpStaffPinSecurity()).resolves.toBeUndefined();
    expect(await getDummyStaffPinHash()).toBe(await getDummyStaffPinHash());
  });
});
