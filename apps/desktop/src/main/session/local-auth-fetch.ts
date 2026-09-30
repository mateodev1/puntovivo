import type { PuntovivoServer } from '@puntovivo/server';

const AUTH_PATHS = new Set([
  '/api/trpc/auth.login',
  '/api/trpc/auth.refresh',
  '/api/trpc/auth.logout',
  '/api/trpc/auth.switchStaff',
]);

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
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
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
