import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class UnsafeUrlError extends Error {}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [a, b] = parts;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast/reserved

  return false;
}

function isPrivateIPv6(address) {
  const lower = address.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isPrivateIPv4(mapped);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local

  return false;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIPv4(address);
  if (net.isIPv6(address)) return isPrivateIPv6(address);
  return true;
}

async function resolveSafeAddress(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError('Ссылка ведёт на внутренний адрес');
    }
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }

  let resolved;
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('Не удалось разрешить адрес ссылки');
  }

  if (!resolved.length || resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new UnsafeUrlError('Ссылка ведёт на внутренний адрес');
  }

  return resolved[0];
}

/**
 * SSRF-защищённый fetch: проверяет схему, резолвит хост один раз и пинит
 * реальное TCP-соединение именно на проверенный адрес (custom `lookup` в
 * connect-опциях undici) — иначе между dns.lookup и самим запросом DNS можно
 * переподменить (rebinding) и всё равно попасть во внутреннюю сеть. Редиректы
 * не следуются автоматически — каждый hop валидируется заново по тем же правилам.
 */
export async function fetchPublicUrl(url, options = {}) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new UnsafeUrlError('Некорректная ссылка');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UnsafeUrlError('Поддерживаются только http/https ссылки');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local')) {
      throw new UnsafeUrlError('Ссылка ведёт на внутренний адрес');
    }

    const resolved = await resolveSafeAddress(hostname);
    const dispatcher = new Agent({
      connect: {
        // Node 20+ can call this with `{all:true}` (Happy Eyeballs / multi-address
        // connect) and expects the array-callback form in that case - the legacy
        // single-address form silently breaks TLS connects (ERR_INVALID_IP_ADDRESS).
        lookup: (_hostname, opts, callback) => {
          if (opts && opts.all) {
            callback(null, [{ address: resolved.address, family: resolved.family }]);
          } else {
            callback(null, resolved.address, resolved.family);
          }
        },
      },
    });

    let response;
    try {
      response = await undiciFetch(currentUrl, { ...options, dispatcher, redirect: 'manual' });
    } finally {
      dispatcher.close().catch(() => {});
    }

    if (REDIRECT_STATUSES.has(response.status) && response.headers.get('location')) {
      currentUrl = new URL(response.headers.get('location'), currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new UnsafeUrlError('Слишком много перенаправлений');
}
