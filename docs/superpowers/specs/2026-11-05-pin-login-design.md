# PIN Login — Design

> Date: 2026-11-05 · Status: approved in conversation, pending spec review

## Problem

Signing in requires a 12+ character password with mixed classes
(`apps/web/src/features/auth/passwordPolicy.ts`). For the owner/admin opening
the desktop app on their own machine this is tedious. We want a 4-digit PIN
as the everyday way in.

## Decisions

1. **One PIN per user, 4 digits.** The existing staff PIN
   (`users.staff_pin_hash`, `packages/server/src/security/staffPins.ts`) is
   reused and shortened from 6 to 4 digits. The same PIN serves PIN login,
   staff switch (`auth.switchStaff`) and manager approvals
   (`managerApprovals`).
2. **PIN login works only in the packaged/local desktop app.** Hub clients and
   standalone web keep password login. A 4-digit PIN reachable over the
   network is not defensible.
3. **Password stays** for first sign-in, recovery, remote/Hub access, and to
   unlock a locked PIN.
4. **Hard lockout:** 5 consecutive wrong PINs for a user lock that user's PIN
   everywhere (login, switch, approvals) until a successful password login or
   an admin resets the PIN.
5. **PIN sessions are capped at 8 hours**, reusing the existing
   `authMethod: 'staff_pin'` claim and `STAFF_PIN_SESSION_TTL_MS`.

## Server (`packages/server`)

### PIN policy
- `staffPins.ts`: `STAFF_PIN_LENGTH = 4`, `STAFF_PIN_PATTERN = /^\d{4}$/`,
  dummy hash `'0000'`. Domain prefix bumps to `puntovivo:staff-pin:v2:`.
- Zod schemas in `trpc/schemas/{auth,users,managerApprovals}.ts` follow the
  new length.

### Migration
- New migration: `UPDATE users SET staff_pin_hash = NULL;` (old 6-digit hashes
  can never verify against a 4-digit PIN; clearing them makes the UI show
  "not configured" instead of failing silently).
- Add `users.pin_failed_attempts integer NOT NULL DEFAULT 0`.

### Lockout
- New helpers in `security/staffPins.ts` (or a small `pinLockout.ts`):
  `isPinLocked(user)`, `registerPinFailure(db, userId)`,
  `resetPinFailures(db, userId)`. Threshold `PIN_LOCKOUT_THRESHOLD = 5`.
- Called from all three verify sites: `auth.pinLogin`, `auth.switchStaff`,
  `managerApprovals` approve. A locked PIN is treated exactly like a wrong PIN
  (same Argon2 cost via dummy hash, error `AUTH_PIN_LOCKED` only after the
  verify so timing does not leak lock state).
- Reset on successful PIN verify, on successful password `auth.login`, and when
  an admin sets/clears the PIN (`users.setStaffPin`).
- Existing per-actor/per-target window buckets in `loginRateLimit.ts` stay as
  an additional throttle.

### New procedures
- `auth.pinLoginCandidates` (query): returns `{ id, name }` of active users in
  the tenant with a non-null, unlocked PIN. Local-capability gated (below).
- `auth.pinLogin` (mutation): input `{ userId, pin }`. Verifies PIN, then
  issues access + refresh tokens exactly like `auth.login`, with
  `createStaffPinSessionClaims()`. Local-capability gated.
- `auth.setMyPin` (protected mutation): input `{ currentPassword, pin | null }`.
  Requires the current password; lets any user set or clear their own PIN.

### Local-capability gate
Mirror the installation-claim pattern
(`apps/desktop/src/main/session/installation-claim.ts`): the embedded server
generates a per-boot random secret, exposed to Electron main only
(`PuntovivoServer.getLocalAuthCapability()`). `pinLogin` and
`pinLoginCandidates` require a matching `x-puntovivo-local-auth` header,
compared in constant time. The secret never reaches the renderer; requests
over real HTTP (Hub, standalone web) never carry it and are refused with
`AUTH_PIN_LOGIN_UNAVAILABLE`.

## Desktop (`apps/desktop`)
- `local-auth-fetch.ts`: allow `/api/trpc/auth.pinLogin` and
  `/api/trpc/auth.pinLoginCandidates`; main injects the capability header.
- `session-ipc.ts` / `preload/session-api.ts`: expose `pinLoginCandidates()`
  and `pinLogin({ userId, pin })` on the existing session bridge. Only in
  packaged-local mode (`isHubClient === false`).

## Web (`apps/web`)
- `LoginPage.tsx`: when the desktop bridge reports PIN login available and
  there is at least one candidate, show "Sign in with PIN" by default: user
  picker + 4-digit numeric input (auto-submit on 4th digit). Link back to
  password login. Locked PIN shows a message pointing to password login.
- `localDesktopAuthTransport.ts`: add `pinLogin`; `AuthProviderImpl.tsx` wires
  it into the same session state as password login.
- Profile/settings: "My PIN" modal using `auth.setMyPin` (asks current
  password + new PIN twice).
- `StaffSwitchModal.tsx`, `StaffPinModal.tsx`, approval PIN inputs: 6 → 4.
- i18n strings for all new copy.

## Docs
- `docs/LOGIN_GUIDE.md`: document PIN login, scope (desktop only), lockout,
  8h cap.

## Testing
- Server: PIN policy (4 digits), migration clears hashes, `pinLogin` success /
  wrong PIN / locked / missing capability / inactive user / timing path,
  lockout shared across login, switch and approvals, reset on password login,
  `setMyPin` requires current password.
- Desktop: `local-auth-fetch` allowlist and header injection; hub mode does
  not expose PIN login.
- Web: `LoginPage` PIN flow and fallback to password; updated 6→4 tests in
  `StaffSwitchModal`, `StaffPinModal`, approvals.
- e2e: update `e2e/web/checkout-approvals.spec.ts` fixtures to 4-digit PINs.

## Out of scope
- PIN login from browser/Hub clients.
- Biometrics, "remember me" changes, changes to the 7-day refresh TTL.
- Changes to the password policy itself.
