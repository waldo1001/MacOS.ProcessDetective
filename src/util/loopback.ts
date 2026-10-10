/** True when `host` (a bind address or a hostname) can only be reached from this machine. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}
