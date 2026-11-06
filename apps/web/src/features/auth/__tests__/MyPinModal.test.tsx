import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from '@/i18n';
import { render, screen, waitFor } from '@/test/utils';

const { mutateAsyncMock, toastSuccessMock, mutationState } = vi.hoisted(() => ({
  mutateAsyncMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  mutationState: { error: null as unknown, isPending: false },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    auth: {
      setMyPin: {
        useMutation: () => ({
          mutateAsync: mutateAsyncMock,
          isPending: mutationState.isPending,
          error: mutationState.error,
        }),
      },
    },
  },
}));

vi.mock('@/components/feedback/ToastProvider', () => ({
  useToast: () => ({ success: toastSuccessMock, error: vi.fn() }),
}));

import { MyPinModal } from '../MyPinModal';

describe('MyPinModal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mutationState.error = null;
    mutationState.isPending = false;
    mutateAsyncMock.mockResolvedValue({ ok: true });
    await i18next.changeLanguage('en');
  });

  it('uses numeric password-type PIN inputs limited to four digits', async () => {
    const user = userEvent.setup();
    render(<MyPinModal isOpen onClose={vi.fn()} />);
    const pin = screen.getByLabelText('New PIN');
    expect(pin).toHaveAttribute('type', 'password');
    expect(pin).toHaveAttribute('inputmode', 'numeric');
    expect(pin).toHaveAttribute('autocomplete', 'off');
    await user.type(pin, '12a3456');
    expect(pin).toHaveValue('1234');
  });

  it('saves a matching four-digit PIN with the current password', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MyPinModal isOpen onClose={onClose} />);
    await user.type(screen.getByLabelText('Current password'), 'Secret-Pass-123!');
    await user.type(screen.getByLabelText('New PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1234');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    await waitFor(() =>
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        currentPassword: 'Secret-Pass-123!',
        pin: '1234',
      })
    );
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks mismatched, short, or passwordless submissions', async () => {
    const user = userEvent.setup();
    render(<MyPinModal isOpen onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('New PIN'), '1234');
    await user.type(screen.getByLabelText('Confirm PIN'), '1235');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(await screen.findByText('Current password is required.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(await screen.findByText('PINs do not match.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('New PIN'));
    await user.clear(screen.getByLabelText('Confirm PIN'));
    await user.type(screen.getByLabelText('New PIN'), '123');
    await user.type(screen.getByLabelText('Confirm PIN'), '123');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(await screen.findByText('Enter exactly 4 digits.')).toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('removes the PIN with the current password', async () => {
    const user = userEvent.setup();
    render(<MyPinModal isOpen onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Remove PIN' }));
    expect(await screen.findByText('Current password is required.')).toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Current password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Remove PIN' }));
    await waitFor(() =>
      expect(mutateAsyncMock).toHaveBeenCalledWith({ currentPassword: 'pw', pin: null })
    );
  });

  it('shows the localized invalid-credentials message', () => {
    mutationState.error = Object.assign(new Error('x'), {
      data: { errorCode: 'AUTH_INVALID_CREDENTIALS' },
    });
    render(<MyPinModal isOpen onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });
});
