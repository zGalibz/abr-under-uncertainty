// Minimal client for Galib's experiment server (contracts/openapi.yaml).
// The runner only creates, watches and aborts runs; the player itself calls
// /start, /events and /finish.

export class ApiError extends Error {
  constructor(status, body, what) {
    super(`${what} failed: HTTP ${status} ${body?.code ?? ''} ${body?.message ?? ''}`.trim());
    this.status = status;
    this.code = body?.code ?? null;
  }
}

export class ServerApi {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
  }

  async #call(method, pathname, body, what) {
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new ApiError(res.status, json, what);
    return json;
  }

  health() { return this.#call('GET', '/healthz', undefined, 'health check'); }
  ready() { return this.#call('GET', '/readyz', undefined, 'readiness check'); }
  createRun(body) { return this.#call('POST', '/api/v1/runs', body, 'create run'); }
  getRun(runId) { return this.#call('GET', `/api/v1/runs/${runId}`, undefined, 'read run'); }
  abortRun(runId, reason) { return this.#call('POST', `/api/v1/runs/${runId}/abort`, { reason: reason.slice(0, 500) }, 'abort run'); }
}

export const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'ABORTED']);
