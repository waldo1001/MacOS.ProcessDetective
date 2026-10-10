import { isLoopbackHost } from '../util/loopback.js';

/**
 * The request guard. The server has no authentication, which was tolerable while it only
 * read. With a write path (and two routes that raise a macOS authorization dialog) any web
 * page the user visits could otherwise POST to it, and DNS rebinding would make that
 * same-origin. Pure: the server passes in the facts about one request.
 *
 *  G1  Host    bound to loopback → the Host header must name this server (defeats DNS rebinding)
 *  G2  Origin  non-GET/HEAD → an Origin header, when present, must equal http://<Host> (defeats CSRF)
 *  G3  actions POST /api/health/action/* → loopback only, JSON content type, body ≤ 64 KiB
 *
 * G1 and G2 apply to every route; the page's own requests already satisfy both.
 */

export const MAX_BODY_BYTES = 64 * 1024;
export const ACTION_PREFIX = '/api/health/action/';

export interface GuardRequest {
  method: string;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  /** The declared Content-Length, when the client sent one. */
  contentLength: number | undefined;
}
export interface GuardContext {
  /** The address the server is bound to (the `--host` option). */
  boundHost: string;
  /** The port the connection actually arrived on. */
  port: number;
}
export type GuardVerdict = { ok: true } | { ok: false; status: number; error: string };

const deny = (status: number, error: string): GuardVerdict => ({ ok: false, status, error });

export function checkRequest(req: GuardRequest, ctx: GuardContext): GuardVerdict {
  const method = req.method.toUpperCase();
  const loopback = isLoopbackHost(ctx.boundHost);
  const host = req.host?.trim().toLowerCase();

  if (loopback) {
    const allowed = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`, `[::1]:${ctx.port}`];
    if (!host || !allowed.includes(host)) return deny(403, `Host "${req.host ?? ''}" is not this server — refused`);
  }

  if (method !== 'GET' && method !== 'HEAD' && req.origin !== undefined) {
    if (!host || req.origin.trim().toLowerCase() !== `http://${host}`) return deny(403, `Origin "${req.origin}" is not this server — refused`);
  }

  if (method === 'POST' && req.pathname.startsWith(ACTION_PREFIX)) {
    if (!loopback) return deny(403, 'clean-up actions are only available when the server is bound to localhost');
    if (!(req.contentType ?? '').trim().toLowerCase().startsWith('application/json')) {
      return deny(415, 'clean-up requests must be sent as application/json');
    }
    if (req.contentLength !== undefined && req.contentLength > MAX_BODY_BYTES) return deny(400, 'request body is larger than 64 KiB');
  }
  return { ok: true };
}
