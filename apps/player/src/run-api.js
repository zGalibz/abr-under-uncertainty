export class HttpRunApi {
  constructor({ baseUrl = '' } = {}) { this.baseUrl = baseUrl.replace(/\/$/, ''); }

  async request(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    return payload;
  }

  createRun(input) { return this.request('/api/v1/runs', input); }
  startRun(runId, input) { return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/start`, input); }
  appendEvents(runId, input) { return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/events`, input); }
  finishRun(runId, input) { return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/finish`, input); }
  abortRun(runId, input) { return this.request(`/api/v1/runs/${encodeURIComponent(runId)}/abort`, input); }
}

/** Resolves the server-issued, run-scoped playlist path without changing it. */
export function resolveRunHlsUrl(hlsUrl, serverBaseUrl, pageUrl = globalThis.location?.href) {
  if (typeof hlsUrl !== 'string' || !hlsUrl.startsWith('/stream/v1/')) throw new Error('server returned an invalid run-scoped hlsUrl');
  if (!serverBaseUrl && !pageUrl) throw new Error('a server base URL or browser location is required to resolve hlsUrl');
  return new URL(hlsUrl, serverBaseUrl || pageUrl).href;
}
