import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalButton } from '@/components/form-controls/Modal';
import { useToast } from '@/components/feedback/ToastProvider';
import { trpc } from '@/lib/trpc';
import { translateServerError } from '@/lib/translateServerError';
import { STAFF_PIN_LENGTH, STAFF_PIN_PATTERN } from './pinPolicy';

interface MyPinModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, STAFF_PIN_LENGTH);

export function MyPinModal({ isOpen, onClose }: MyPinModalProps) {
  const { t } = useTranslation(['auth', 'errors']);
  const toast = useToast();
  const setMyPin = trpc.auth.setMyPin.useMutation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleClose = () => {
    setCurrentPassword('');
    setPin('');
    setConfirmPin('');
    setValidationError(null);
    setMyPin.reset?.();
    onClose();
  };

  const submit = async (mode: 'save' | 'remove') => {
    if (!currentPassword) {
      setValidationError(t('auth:myPin.currentRequired'));
      return;
    }
    if (mode === 'save') {
      if (!STAFF_PIN_PATTERN.test(pin) || !STAFF_PIN_PATTERN.test(confirmPin)) {
        setValidationError(t('auth:myPin.pinInvalid'));
        return;
      }
      if (pin !== confirmPin) {
        setValidationError(t('auth:myPin.mismatch'));
        return;
      }
    }
    setValidationError(null);
    try {
      await setMyPin.mutateAsync({ currentPassword, pin: mode === 'save' ? pin : null });
    } catch {
      return;
    }
    toast.success({
      title: t(mode === 'save' ? 'auth:myPin.saved' : 'auth:myPin.removed'),
    });
    handleClose();
  };

  const serverError = setMyPin.error
    ? translateServerError(setMyPin.error, t, t('auth:myPin.error'))
    : null;
  const shownError = validationError ?? serverError;
  const pending = setMyPin.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('auth:myPin.title')}
      size="sm"
      footer={
        <>
          <ModalButton
            variant="danger"
            onClick={() => void submit('remove')}
            disabled={pending}
            className="sm:mr-auto"
          >
            {t('auth:myPin.remove')}
          </ModalButton>
          <ModalButton onClick={handleClose} disabled={pending}>
            {t('auth:myPin.cancel')}
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit('save')} disabled={pending}>
            {pending ? t('auth:myPin.saving') : t('auth:myPin.save')}
          </ModalButton>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          void submit('save');
        }}
      >
        <p className="text-sm text-secondary-600">{t('auth:myPin.description')}</p>

        <div>
          <label htmlFor="my-pin-password" className="label">
            {t('auth:myPin.currentPassword')}
          </label>
          <input
            id="my-pin-password"
            type="password"
            autoComplete="current-password"
            className="input mt-1"
            value={currentPassword}
            onChange={event => {
              setCurrentPassword(event.target.value);
              setValidationError(null);
            }}
          />
        </div>

        <div>
          <label htmlFor="my-pin-new" className="label">
            {t('auth:myPin.newPin')}
          </label>
          <input
            id="my-pin-new"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={STAFF_PIN_LENGTH}
            className="input mt-1 font-mono tracking-[0.35em]"
            value={pin}
            placeholder={t('auth:myPin.placeholder')}
            onChange={event => {
              setPin(digitsOnly(event.target.value));
              setValidationError(null);
            }}
          />
        </div>

        <div>
          <label htmlFor="my-pin-confirm" className="label">
            {t('auth:myPin.confirmPin')}
          </label>
          <input
            id="my-pin-confirm"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={STAFF_PIN_LENGTH}
            className="input mt-1 font-mono tracking-[0.35em]"
            value={confirmPin}
            placeholder={t('auth:myPin.placeholder')}
            onChange={event => {
              setConfirmPin(digitsOnly(event.target.value));
              setValidationError(null);
            }}
          />
        </div>

        {shownError && (
          <p role="alert" className="text-sm text-danger-600">
            {shownError}
          </p>
        )}
      </form>
    </Modal>
  );
}
