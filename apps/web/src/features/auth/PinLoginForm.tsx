import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { extractServerErrorCode, translateServerError } from '@/lib/translateServerError';
import { useAuth } from './AuthProvider';
import { pinLoginCandidatesLocal } from './localDesktopAuthTransport';
import { STAFF_PIN_LENGTH, STAFF_PIN_PATTERN } from './pinPolicy';

interface PinLoginFormProps {
  /** `'no-candidates'` when nobody can sign in with a PIN here yet. */
  onUsePassword: (reason?: 'no-candidates') => void;
}

type Candidate = { id: string; name: string };

const PASSWORD_FALLBACK_CODES = new Set([
  'AUTH_PIN_LOCKED',
  'AUTH_RATE_LIMIT_EXCEEDED',
  'AUTH_PIN_LOGIN_UNAVAILABLE',
]);

export function PinLoginForm({ onUsePassword }: PinLoginFormProps) {
  const { t } = useTranslation(['auth', 'errors']);
  const { loginWithPin } = useAuth();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showPasswordHint, setShowPasswordHint] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onUsePasswordRef = useRef(onUsePassword);
  useEffect(() => {
    onUsePasswordRef.current = onUsePassword;
  }, [onUsePassword]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await pinLoginCandidatesLocal();
        if (cancelled) return;
        if (list.length === 0) {
          onUsePasswordRef.current('no-candidates');
          return;
        }
        setCandidates(list);
        if (list.length === 1 && list[0]) setUserId(list[0].id);
      } catch {
        // Silent fallback: password sign-in is always available.
        if (!cancelled) onUsePasswordRef.current();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (nextPin: string) => {
      if (!userId || !STAFF_PIN_PATTERN.test(nextPin)) return;
      setIsSubmitting(true);
      setError(null);
      setShowPasswordHint(false);
      try {
        await loginWithPin({ userId, pin: nextPin });
      } catch (err) {
        const code = extractServerErrorCode(err);
        setError(translateServerError(err, t, t('errors:server.AUTH_STAFF_PIN_INVALID')));
        setShowPasswordHint(code !== null && PASSWORD_FALLBACK_CODES.has(code));
        setPin('');
        setIsSubmitting(false);
        // Re-enable happens on the next render; focus once the input is usable.
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      setIsSubmitting(false);
    },
    [loginWithPin, t, userId]
  );

  if (!candidates) {
    return <p className="mt-8 text-sm text-fg2">{t('auth:pinLogin.loading')}</p>;
  }

  return (
    <form
      className="mt-8 space-y-5"
      onSubmit={event => {
        event.preventDefault();
        void submit(pin);
      }}
    >
      <p className="text-sm text-fg2">{t('auth:pinLogin.description')}</p>

      {error && (
        <div
          role="alert"
          className="rounded-[11px] border border-danger-500/20 bg-danger-50 px-4 py-3 text-sm text-danger-700"
        >
          {error}
        </div>
      )}
      {showPasswordHint && <p className="text-sm text-fg2">{t('auth:pinLogin.passwordHint')}</p>}

      <fieldset className="space-y-2">
        <legend className="label">{t('auth:pinLogin.userLabel')}</legend>
        {candidates.map(candidate => (
          <label
            key={candidate.id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3 has-[:checked]:border-primary-400 has-[:checked]:bg-primary-50"
          >
            <input
              type="radio"
              name="pin-login-user"
              value={candidate.id}
              checked={userId === candidate.id}
              disabled={isSubmitting}
              onChange={() => {
                setUserId(candidate.id);
                setError(null);
                setShowPasswordHint(false);
                setTimeout(() => inputRef.current?.focus(), 0);
              }}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-secondary-950">
              {candidate.name}
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label htmlFor="pin-login-pin" className="label">
          {t('auth:pinLogin.pinLabel')}
        </label>
        <input
          ref={inputRef}
          id="pin-login-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={STAFF_PIN_LENGTH}
          className="input mt-1 font-mono tracking-[0.35em]"
          value={pin}
          disabled={isSubmitting || !userId}
          onChange={event => {
            const next = event.target.value.replace(/\D/g, '').slice(0, STAFF_PIN_LENGTH);
            setPin(next);
            setError(null);
            setShowPasswordHint(false);
            if (next.length === STAFF_PIN_LENGTH) void submit(next);
          }}
        />
        {isSubmitting && (
          <p role="status" className="mt-2 text-xs text-fg2">
            {t('auth:pinLogin.submitting')}
          </p>
        )}
      </div>

      <button
        type="button"
        className="btn-ghost w-full justify-center"
        onClick={() => onUsePassword()}
      >
        {t('auth:pinLogin.usePassword')}
      </button>
    </form>
  );
}
