import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/test/utils';

const mocks = vi.hoisted(() => ({
  loginWithPin: vi.fn(),
  candidates: vi.fn(),
}));

vi.mock('./AuthProvider', () => ({
  useAuth: () => ({ loginWithPin: mocks.loginWithPin, isLoading: false }),
}));
vi.mock('./localDesktopAuthTransport', () => ({
  pinLoginCandidatesLocal: mocks.candidates,
}));

import { PinLoginForm } from './PinLoginForm';

const coded = (code: string) => Object.assign(new Error(code), { data: { errorCode: code } });

describe('PinLoginForm', () => {
  beforeEach(() => {
    mocks.loginWithPin.mockReset().mockResolvedValue(undefined);
    mocks.candidates.mockReset().mockResolvedValue([
      { id: 'u1', name: 'Ana Cashier' },
      { id: 'u2', name: 'Beto Cashier' },
    ]);
  });

  it('auto-submits on the fourth digit and only accepts digits', async () => {
    const user = userEvent.setup();
    render(<PinLoginForm onUsePassword={vi.fn()} />);
    await user.click(await screen.findByLabelText('Beto Cashier'));
    const input = screen.getByLabelText(/pin/i);
    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.type(input, '12a3');
    expect(mocks.loginWithPin).not.toHaveBeenCalled();
    await user.type(input, '4');
    await waitFor(() =>
      expect(mocks.loginWithPin).toHaveBeenCalledWith({ userId: 'u2', pin: '1234' })
    );
  });

  it('preselects a single candidate', async () => {
    mocks.candidates.mockResolvedValue([{ id: 'u1', name: 'Ana Cashier' }]);
    const user = userEvent.setup();
    render(<PinLoginForm onUsePassword={vi.fn()} />);
    await user.type(await screen.findByLabelText(/pin/i), '1111');
    await waitFor(() =>
      expect(mocks.loginWithPin).toHaveBeenCalledWith({ userId: 'u1', pin: '1111' })
    );
  });

  it('clears the input and shows the error on a wrong PIN', async () => {
    mocks.loginWithPin.mockRejectedValue(coded('AUTH_STAFF_PIN_INVALID'));
    const user = userEvent.setup();
    render(<PinLoginForm onUsePassword={vi.fn()} />);
    await user.click(await screen.findByLabelText('Ana Cashier'));
    const input = screen.getByLabelText(/pin/i);
    await user.type(input, '0000');
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid/i);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it.each(['AUTH_PIN_LOCKED', 'AUTH_RATE_LIMIT_EXCEEDED'])(
    '%s shows the password hint and switch link',
    async code => {
      mocks.loginWithPin.mockRejectedValue(coded(code));
      const onUsePassword = vi.fn();
      const user = userEvent.setup();
      render(<PinLoginForm onUsePassword={onUsePassword} />);
      await user.click(await screen.findByLabelText('Ana Cashier'));
      await user.type(screen.getByLabelText(/pin/i), '0000');
      await screen.findByRole('alert');
      expect(screen.getByText(/password/i, { selector: 'p' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /use password/i }));
      expect(onUsePassword).toHaveBeenCalledOnce();
    }
  );

  it('falls back to password when there are no candidates or loading fails', async () => {
    mocks.candidates.mockResolvedValue([]);
    const onUsePassword = vi.fn();
    const { unmount } = render(<PinLoginForm onUsePassword={onUsePassword} />);
    await waitFor(() => expect(onUsePassword).toHaveBeenCalledOnce());
    unmount();
    mocks.candidates.mockRejectedValue(new Error('boom'));
    const second = vi.fn();
    render(<PinLoginForm onUsePassword={second} />);
    await waitFor(() => expect(second).toHaveBeenCalledOnce());
  });
});
