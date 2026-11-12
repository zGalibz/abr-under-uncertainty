const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const ALLOWED_HEADERS = new Set(['content-type', 'range']);

export function parseAllowedOrigins(value = '') {
  return new Set(
    String(value)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

export function applyCors(request, response, allowedOrigins) {
  const origin = request.headers.origin;

  if (origin) {
    if (!allowedOrigins.has(origin)) {
      return { allowed: false, preflight: request.method === 'OPTIONS' };
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    response.setHeader(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Length, Content-Range, X-Run-Id, X-Scenario-Phase'
    );
  }

  if (request.method !== 'OPTIONS') {
    return { allowed: true, preflight: false };
  }

  const requestedMethod = request.headers['access-control-request-method'];

  if (requestedMethod && !ALLOWED_METHODS.has(requestedMethod.toUpperCase())) {
    return { allowed: false, preflight: true };
  }

  const requestedHeaders = String(
    request.headers['access-control-request-headers'] || ''
  )
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);

  if (requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
    return { allowed: false, preflight: true };
  }

  return { allowed: true, preflight: true };
}
