export class HttpRunApi {
  constructor({ baseUrl = '' } = {}) { this.baseUrl = baseUrl; }

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
