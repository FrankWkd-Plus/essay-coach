export class ApiError extends Error {
  constructor(code, message, status = 0, body = null) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError('network_error', '网络连接失败，请检查网络后重试。');
  }

  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new ApiError('invalid_response', '服务器返回了意外的响应。', response.status);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('invalid_response', '服务器返回的 JSON 无效。', response.status);
  }

  if (response.ok && body?.ok !== false) return body;
  const code = typeof body?.code === 'string'
    ? body.code
    : response.ok ? 'request_failed' : `http_${response.status}`;
  const message = typeof body?.message === 'string'
    ? body.message
    : '请求失败，请稍后重试。';
  throw new ApiError(code, message, response.status, body);
}

export const api = {
  health: (signal) => requestJson('/api/health', { signal }),
  grade: (payload, requestId, signal) => requestJson('/api/grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, requestId }),
    signal
  }),
  job: (id, signal) => requestJson(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
  adminLogin: (token, signal) => requestJson('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal
  }),
  admin: (path, token, options = {}) => requestJson(`/api/admin/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'x-admin-token': token
    }
  })
};
