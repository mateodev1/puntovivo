import type { Tenant, User } from '@/types';

// Legacy key — full `User` objects (name, email, role) were persisted here
// through 1.2.x. Nothing ever read it back (AuthProvider rehydrates via
// `auth.me`), so it was pure offline-PII exposure under XSS or a shared
// terminal. It is now only ever removed, so upgraded installs get cleaned.
const AUTH_USER_KEY = 'auth_user';
const AUTH_TENANT_KEY = 'auth_tenant';
const LAST_DESKTOP_EMAIL_KEY = 'puntovivo:last-desktop-login-email:v1';

function isPackagedDesktop(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'puntovivo-app:';
}

/** Display-only preference on this desktop install; never grants authority. */
export function getLastDesktopLoginEmail(): string {
  if (!isPackagedDesktop()) return '';
  try {
    const email = window.localStorage.getItem(LAST_DESKTOP_EMAIL_KEY);
    return email && email.length <= 254 ? email : '';
  } catch {
    return '';
  }
}

/** Called only after password login and auth.me verify the signed-in user. */
export function rememberLastDesktopLoginEmail(email: string): void {
  if (!isPackagedDesktop() || !email || email.length > 254) return;
  try {
    window.localStorage.setItem(LAST_DESKTOP_EMAIL_KEY, email);
  } catch {
    // A blocked preference write must never turn a successful login into a failure.
  }
}

export interface StoredAuthSnapshot {
  user: User;
  tenant: Tenant | null;
}

interface StoredTenantRef {
  id: string;
}

export function getStoredAuthTenant(): StoredTenantRef | null {
  const serializedTenant = window.localStorage.getItem(AUTH_TENANT_KEY);
  if (!serializedTenant) {
    return null;
  }

  try {
    const parsed = JSON.parse(serializedTenant) as Partial<StoredTenantRef> | null;
    return parsed && typeof parsed.id === 'string' ? { id: parsed.id } : null;
  } catch {
    return null;
  }
}

export function getStoredAuthTenantId(): string | null {
  return getStoredAuthTenant()?.id ?? null;
}

/**
 * Persist the minimum the app reads back across reloads: the tenant id
 * (site storage + offline sync scope keys). The user identity is NEVER
 * persisted — `auth.me` is the single rehydration source — so localStorage
 * carries no name/email PII as session authority. The separate packaged-only
 * last-email preference is display-only and intentionally survives logout.
 */
export function persistAuthSession(snapshot: StoredAuthSnapshot): void {
  window.localStorage.removeItem(AUTH_USER_KEY);

  if (snapshot.tenant) {
    window.localStorage.setItem(AUTH_TENANT_KEY, JSON.stringify({ id: snapshot.tenant.id }));
    return;
  }

  window.localStorage.removeItem(AUTH_TENANT_KEY);
}

export function clearAuthSession(): void {
  window.localStorage.removeItem(AUTH_USER_KEY);
  window.localStorage.removeItem(AUTH_TENANT_KEY);
}

// Non-authoritative operator intent only: never a credential or cached identity.
const REQUIRE_SIGN_IN_KEY = 'puntovivo:require-explicit-sign-in:v1';

/** Suppress cookie/main auto-resume after an explicit recovery account change. */
export function requireExplicitSignIn(): void {
  window.localStorage.setItem(REQUIRE_SIGN_IN_KEY, '1');
}

/** A storage failure must not accidentally restore the previous operator. */
export function isExplicitSignInRequired(): boolean {
  try {
    return window.localStorage.getItem(REQUIRE_SIGN_IN_KEY) !== null;
  } catch {
    return true;
  }
}

/** Clear the local intent only after fresh login and auth.me verified the identity. */
export function allowSessionResumeAfterSignIn(): void {
  window.localStorage.removeItem(REQUIRE_SIGN_IN_KEY);
}
