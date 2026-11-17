const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

export class HttpError extends Error {
  constructor(code, status = 400, message = '', options = {}) {
    super(message || code);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.extra = options.extra || {};
    this.headers = options.headers || {};
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isValidIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isValidIp(value) {
  if (typeof value !== 'string' || !value || value.length > 45) return false;
  const ip = value.trim();
  if (ip.includes(':')) return /^[0-9a-fA-F:.]+$/.test(ip) && ip.length >= 2;
  return isValidIpv4(ip);
}

export function clientIp(request) {
  const candidates = [
    request.headers.get('cf-connecting-ip'),
    request.headers.get('x-real-ip'),
    (request.headers.get('x-forwarded-for') || '').split(',')[0]
  ];
  for (const candidate of candidates) {
    const value = (candidate || '').trim();
    if (isValidIp(value)) return value;
  }
  return 'unknown';
}

export function cleanText(value, maxLength) {
  if (value == null) return '';
  let text = String(value).replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function normalizeRawText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

export function textField(value, maxLength, code) {
  const text = normalizeRawText(value);
  if (text.length > maxLength) throw new HttpError(code, 413);
  return text;
}

export async function readText(request, maxBytes = 32768) {
  if (!request.body) throw new HttpError('invalid_input', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError('payload_too_large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError('invalid_encoding', 400);
  }
}

export async function readJson(request, maxBytes = 32768) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError('invalid_content_type', 415);
  const text = await readText(request, maxBytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const error = new HttpError('invalid_json', 400);
    error.rawText = text.slice(0, 8000);
    throw error;
  }
  if (!isPlainObject(value)) {
    const error = new HttpError('invalid_input', 400);
    error.rawText = text.slice(0, 8000);
    throw error;
  }
  return value;
}

export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin) {
    let same = false;
    try {
      same = new URL(origin).origin === new URL(request.url).origin;
    } catch {
      same = false;
    }
    if (!same) throw new HttpError('cross_origin_rejected', 403);
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError('cross_origin_rejected', 403);
  }
}

export function requestMeta(request) {
  const cf = request.cf || {};
  return {
    country: typeof cf.country === 'string' ? cf.country : null,
    colo: typeof cf.colo === 'string' ? cf.colo : null,
    asn: cf.asn == null ? null : String(cf.asn),
    origin: request.headers.get('origin') || null,
    requestId: crypto.randomUUID()
  };
}

export function userAgent(request) {
  return cleanText(request.headers.get('user-agent') || '', 400);
}

export function referer(request) {
  return cleanText(request.headers.get('referer') || '', 500);
}

export function parseJsonOrText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}
