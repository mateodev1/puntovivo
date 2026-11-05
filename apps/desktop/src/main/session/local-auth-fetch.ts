import { LOCAL_AUTH_CAPABILITY_HEADER, type PuntovivoServer } from '@puntovivo/server';

const AUTH_PATHS = new Set([
  '/api/trpc/auth.login',
  '/api/trpc/auth.refresh',
  '/api/trpc/auth.logout',
  '/api/trpc/auth.switchStaff',
  '/api/trpc/auth.pinLogin',
  '/api/trpc/auth.pinLoginCandidates',
]);

/** Only these paths carry the per-boot local-auth capability. */
const PIN_PATHS = new Set(['/api/trpc/auth.pinLogin', '/api/trpc/auth.pinLoginCandidates']);

/** Keep packaged-local auth inside main and the embedded Fastify instance. */
export function createLocalAuthFetch(
  getActiveServer: () => PuntovivoServer | null,
  origin: string
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== origin || !AUTH_PATHS.has(url.pathname) || init?.method !== 'POST') {
      throw new Error('Local desktop auth target is not allowed');
    }
    const server = getActiveServer();
    if (!server) throw new Error('The embedded server is not available');
    const requestHeaders = new Headers(init?.headers);
    // Never forward a caller-supplied capability; only main may attach it.
    requestHeaders.delete(LOCAL_AUTH_CAPABILITY_HEADER);
    if (PIN_PATHS.has(url.pathname)) {
      requestHeaders.set(LOCAL_AUTH_CAPABILITY_HEADER, server.getLocalAuthCapability());
    }
    const headers = Object.fromEntries(requestHeaders.entries());
    const reply = await server.app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(reply.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(name, item);
      } else if (value !== undefined) {
        responseHeaders.append(name, String(value));
      }
    }
    return new Response(reply.body, { status: reply.statusCode, headers: responseHeaders });
  }) as typeof fetch;
}
