/**
 * Optional HTTP Basic auth for the web server.
 *
 * Set `CONDUIT_AUTH=user:pass` (the older `AGENT_ORG_AUTH` name is accepted
 * too). When unset, the server is open — fine for a laptop on localhost, not
 * for anything reachable from another machine. The same credential protects
 * REST, the browser WebSocket, and static files.
 *
 * Local helper processes (the per-agent MCP server, the Strands tools) send
 * the same credential in an `Authorization` header — see `authHeader()`.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';

export interface AuthConfig {
  user: string;
  pass: string;
}

function parse(): AuthConfig | null {
  const raw = process.env.CONDUIT_AUTH || process.env.AGENT_ORG_AUTH || '';
  if (!raw.trim()) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    console.warn('[auth] CONDUIT_AUTH must look like user:password — ignoring');
    return null;
  }
  return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
}

let cached: AuthConfig | null | undefined;

export function getAuthConfig(): AuthConfig | null {
  if (cached === undefined) cached = parse();
  return cached;
}

export function isAuthEnabled(): boolean {
  return getAuthConfig() !== null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the request carries valid credentials (or auth is off). */
export function isAuthorized(req: IncomingMessage): boolean {
  const cfg = getAuthConfig();
  if (!cfg) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8'); }
  catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return safeEqual(decoded.slice(0, idx), cfg.user) && safeEqual(decoded.slice(idx + 1), cfg.pass);
}

/** Express middleware — challenges with 401 when credentials are missing. */
export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (isAuthorized(req)) { next(); return; }
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="Conduit", charset="UTF-8"');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Authentication required' }));
}

/** Header a local helper should attach when calling the web server. */
export function authHeader(): Record<string, string> {
  const cfg = getAuthConfig();
  if (!cfg) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64') };
}

export function isValidAuthFormat(authString: string): boolean {
  return /^[^:]+:[^:]+$/.test(authString);
}

import crypto from 'node:crypto';
export function constantTimeStringCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
