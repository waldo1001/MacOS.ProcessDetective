import { describe, expect, it } from 'vitest';
import { checkRequest, MAX_BODY_BYTES, type GuardRequest } from '../src/server/guard.js';
import { isLoopbackHost } from '../src/util/loopback.js';

const PORT = 7878;
const ctx = { boundHost: '127.0.0.1', port: PORT };
const req = (over: Partial<GuardRequest> = {}): GuardRequest => ({
  method: 'GET', pathname: '/api/health', host: `127.0.0.1:${PORT}`, origin: undefined, contentType: undefined, contentLength: undefined, ...over,
});
const status = (r: ReturnType<typeof checkRequest>): number => (r.ok ? 200 : r.status);

describe('G1: Host', () => {
  it('accepts the three loopback spellings on the real port', () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
      expect(status(checkRequest(req({ host }), ctx)), host).toBe(200);
    }
  });
  it('refuses another name or another port (DNS rebinding) with 403, for GET as well', () => {
    for (const host of ['evil.example:7878', 'evil.example', '127.0.0.1:1', `127.0.0.1:${PORT + 1}`, `localhost.evil.example:${PORT}`, `127.0.0.1.evil.example:${PORT}`, '127.0.0.1', undefined]) {
      expect(status(checkRequest(req({ host }), ctx)), String(host)).toBe(403);
    }
    expect(status(checkRequest(req({ host: 'evil.example:7878', pathname: '/api/system' }), ctx))).toBe(403);
    expect(status(checkRequest(req({ host: 'evil.example:7878', pathname: '/' }), ctx))).toBe(403);
  });
  it('applies to every route and every method', () => {
    for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE']) {
      expect(status(checkRequest(req({ method, host: 'evil.example:7878', pathname: '/api/processes' }), ctx)), method).toBe(403);
    }
  });
  it('is not applied when the user bound the server to another interface', () => {
    expect(status(checkRequest(req({ host: '192.168.1.5:7878' }), { boundHost: '0.0.0.0', port: PORT }))).toBe(200);
  });
  it('works for the other loopback binds', () => {
    expect(status(checkRequest(req({ host: `localhost:${PORT}` }), { boundHost: 'localhost', port: PORT }))).toBe(200);
    expect(status(checkRequest(req({ host: `[::1]:${PORT}` }), { boundHost: '::1', port: PORT }))).toBe(200);
    expect(status(checkRequest(req({ host: 'evil.example:7878' }), { boundHost: '::1', port: PORT }))).toBe(403);
  });
});

describe('G2: Origin on anything that is not GET/HEAD', () => {
  const post = (origin: string | undefined, over: Partial<GuardRequest> = {}) => checkRequest(req({ method: 'POST', pathname: '/api/health/scan', origin, ...over }), ctx);
  it('refuses a foreign Origin with 403', () => {
    expect(status(post('http://evil.example'))).toBe(403);
    expect(status(post('http://evil.example:7878'))).toBe(403);
    expect(status(post('null'))).toBe(403);
    expect(status(post('https://127.0.0.1:7878'))).toBe(403);
    expect(status(post('http://127.0.0.1:1'))).toBe(403);
    expect(status(post('http://localhost:7878'))).toBe(403); // a different name than the Host header used
  });
  it('accepts the matching Origin, or none at all (a non-browser client)', () => {
    expect(status(post(`http://127.0.0.1:${PORT}`))).toBe(200);
    expect(status(post(undefined))).toBe(200);
    expect(status(post(`http://LOCALHOST:${PORT}`, { host: `localhost:${PORT}` }))).toBe(200);
  });
  it('is for non-GET only: a GET with a foreign Origin is fine', () => {
    expect(status(checkRequest(req({ method: 'GET', origin: 'http://evil.example' }), ctx))).toBe(200);
    expect(status(checkRequest(req({ method: 'HEAD', origin: 'http://evil.example' }), ctx))).toBe(200);
  });
  it('guards the old routes too (the elevated sample and the login-items check raise dialogs)', () => {
    for (const p of ['/api/sample/123', '/api/powermetrics', '/api/health/check/login-items', '/api/docker', '/api/advice/9']) {
      expect(status(checkRequest(req({ method: 'POST', pathname: p, origin: 'http://evil.example' }), ctx)), p).toBe(403);
      expect(status(checkRequest(req({ method: 'POST', pathname: p, origin: `http://127.0.0.1:${PORT}` }), ctx)), p).toBe(200);
    }
  });
});

describe('G3: action routes', () => {
  const action = (over: Partial<GuardRequest> = {}, c = ctx) =>
    checkRequest(req({ method: 'POST', pathname: '/api/health/action/plan', contentType: 'application/json', origin: `http://127.0.0.1:${PORT}`, ...over }), c);

  it('accepts JSON (also with a charset) from a loopback server', () => {
    expect(status(action())).toBe(200);
    expect(status(action({ contentType: 'application/json; charset=utf-8' }))).toBe(200);
    expect(status(action({ contentType: 'Application/JSON' }))).toBe(200);
    expect(status(action({ pathname: '/api/health/action/execute' }))).toBe(200);
  });
  it('refuses any other content type with 415', () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', undefined, 'text/plain; application/json']) {
      expect(status(action({ contentType })), String(contentType)).toBe(415);
    }
  });
  it('refuses an action route while bound to 0.0.0.0 with 403', () => {
    expect(status(action({ host: '192.168.1.5:7878', origin: undefined }, { boundHost: '0.0.0.0', port: PORT }))).toBe(403);
    expect(status(action({}, { boundHost: '::', port: PORT }))).toBe(403);
  });
  it('refuses a declared body over 64 KiB with 400', () => {
    expect(status(action({ contentLength: MAX_BODY_BYTES }))).toBe(200);
    expect(status(action({ contentLength: MAX_BODY_BYTES + 1 }))).toBe(400);
  });
  it('a foreign Origin is a 403 before the content type is even looked at', () => {
    expect(status(action({ origin: 'http://evil.example', contentType: 'text/plain' }))).toBe(403);
  });
  it('is for the action routes only: other POST routes need no content type', () => {
    expect(status(checkRequest(req({ method: 'POST', pathname: '/api/health/scan', contentType: undefined }), ctx))).toBe(200);
    expect(status(checkRequest(req({ method: 'POST', pathname: '/api/health/actions', contentType: 'text/plain' }), ctx))).toBe(200);
  });
  it('the read routes of the action layer are plain GETs and need nothing special', () => {
    expect(status(checkRequest(req({ pathname: '/api/health/actions' }), ctx))).toBe(200);
    expect(status(checkRequest(req({ pathname: '/api/health/actions/log' }), ctx))).toBe(200);
  });
});

describe('isLoopbackHost', () => {
  it('knows the loopback spellings and nothing else', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LocalHost', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '127.0.0.1.evil.example', '', undefined, null]) expect(isLoopbackHost(h), String(h)).toBe(false);
  });
});
