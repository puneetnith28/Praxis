import { demoApi } from './demo/backend';

/**
 * Is this build the hosted static preview?
 *
 * The preview deployment is the client bundle with no Conduit behind it — no
 * daemon, no PTYs, nothing serving `/api/*`. So every request it makes answers
 * 404 and every socket it opens fails, and because the usage panels poll on a
 * timer the failures never stop: a visitor who opens devtools sees a console
 * filling up with errors for a condition the preview banner already explains in
 * a sentence.
 *
 * Making the requests anyway proves nothing. When the page can know there is no
 * backend, the honest thing is to say so and stay quiet.
 *
 * Two ways it knows, and the second is the one that matters:
 *
 *   VITE_STATIC_PREVIEW=1   set in the hosting environment. Vite inlines it at
 *                           build time, so a local build — where the variable is
 *                           unset — is the app it always was.
 *
 *   a *.vercel.app host     Conduit's backend is a long-lived daemon that owns
 *                           real PTYs. Vercel's platform cannot run one, so a
 *                           Conduit served from vercel.app never has a backend.
 *                           That is a property of the architecture, not a
 *                           deployment setting, which is why it does not depend
 *                           on remembering to configure anything.
 *
 * The host check is deliberately narrow: only vercel.app, never a custom domain,
 * because a custom domain can point at a real server and this must never make a
 * working install refuse to talk to its own daemon.
 */
const onVercelPreview = typeof window !== 'undefined'
  && /(^|\.)vercel\.app$/.test(window.location.hostname);

export const STATIC_PREVIEW =
  import.meta.env.VITE_STATIC_PREVIEW === '1' || onVercelPreview;

/** What every server-backed request answers with on the preview. */
export const NO_BACKEND =
  'this is the hosted preview, and there is no Bedrock running behind it';

/**
 * Answer the app's own API calls locally, instead of letting them reach a host
 * that has no API.
 *
 * Gating call sites one at a time does not hold. Each one missed is a 404 in
 * the console, and worse than the 404: the host answers a *page* — Vercel's
 * "The page could not be found" — so `res.json()` throws
 * `Unexpected token 'T'` and that lands in the interface as the reason the
 * Keeper is unavailable. A visitor is shown a parser error where an
 * explanation belongs.
 *
 * One guard at the entry point covers every caller, including the ones written
 * after this: same-origin `/api/*` and `/downloads` resolve immediately with a
 * 503 and a JSON body saying why. No request leaves the browser, every caller
 * gets the JSON shape it expects, and the reason it can show the user is a
 * sentence rather than a stack trace.
 *
 * Off entirely when STATIC_PREVIEW is false, so it cannot affect a real install.
 */
export function installPreviewFetchGuard(): void {
  if (!STATIC_PREVIEW || typeof window === 'undefined') return;

  const real = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input.url;

    let path: string;
    try {
      const u = new URL(href, window.location.origin);
      // Only our own server's routes. Anything cross-origin is somebody else's
      // and none of this guard's business.
      path = u.origin === window.location.origin ? u.pathname : '';
    } catch { path = ''; }

    if (path === '/api' || path.startsWith('/api/')) {
      // Answered in the browser, from fixtures. See client/demo/backend.ts.
      const u = new URL(href, window.location.origin);
      return Promise.resolve(demoApi(u.pathname.slice(4) + u.search, init));
    }

    if (path === '/downloads' || path.startsWith('/downloads/')) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: NO_BACKEND }),
        { status: 503, statusText: 'No backend', headers: { 'content-type': 'application/json' } },
      ));
    }

    return real(input as RequestInfo, init);
  };
}
