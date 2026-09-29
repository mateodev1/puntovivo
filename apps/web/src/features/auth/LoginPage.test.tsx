import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import i18n from '@/i18n';
import { render } from '@/test/utils';

const authMock = vi.hoisted(() => ({
  error: null as unknown,
  login: vi.fn(),
}));
const lastEmailMock = vi.hoisted(() => vi.fn(() => ''));

vi.mock('./authStorage', async () => ({
  ...(await vi.importActual<typeof import('./authStorage')>('./authStorage')),
  getLastDesktopLoginEmail: lastEmailMock,
}));

vi.mock('./AuthProvider', () => ({
  useAuth: () => ({
    login: authMock.login,
    isLoading: false,
    error: authMock.error,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  vanillaClient: {
    auth: { setupStatus: { query: vi.fn(async () => ({ required: false, countries: [] })) } },
  },
}));

import { LoginPage } from './LoginPage';

it('prefills the last desktop email but leaves the password blank', () => {
  authMock.error = null;
  lastEmailMock.mockReturnValue('last@example.com');
  render(<LoginPage />);
  expect(screen.getByLabelText(/email|correo/i)).toHaveValue('last@example.com');
  expect(document.querySelector('#password')).toHaveValue('');
  lastEmailMock.mockReturnValue('');
});

describe('LoginPage Store Hub errors', () => {
  beforeEach(() => {
    authMock.login.mockReset();
    authMock.error = new Error('STORE_HUB_LOCAL_SESSION_ERROR');
  });

  it.each([
    ['en', 'Your session is no longer active on this device. Sign in again and retry.'],
    [
      'es',
      'Tu sesión ya no está activa en este equipo. Inicia sesión de nuevo y vuelve a intentarlo.',
    ],
  ] as const)(
    'renders safe localized copy for an unreadable local session in %s',
    async (locale, expected) => {
      await i18n.changeLanguage(locale);

      render(<LoginPage />);

      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(
        /STORE_HUB_LOCAL_SESSION_ERROR|\/Users\/|Library\/Application Support|keychain/i
      );
    }
  );
});

it.each([
  ['en', 'This register is still assigned to another operator.'],
  ['es', 'Esta caja sigue asignada a otro operador.'],
] as const)(
  'explains verified staff handoff rather than allowing partial login in %s',
  async (locale, expected) => {
    await i18n.changeLanguage(locale);
    authMock.error = { data: { errorCode: 'AUTH_IDENTITY_CHANGED' } };
    render(<LoginPage />);
    expect(screen.getByText(text => text.startsWith(expected))).toBeVisible();
    expect(document.body).not.toHaveTextContent('AUTH_IDENTITY_CHANGED');
  }
);
