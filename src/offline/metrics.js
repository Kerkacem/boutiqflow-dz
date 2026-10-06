/**
 * BoutiqFlow DZ — Offline Sync Observability & Metrics (INV-08-20)
 * Tracks operational telemetry without logging credentials, tokens or unnecessary PII.
 */

class OfflineMetrics {
  constructor() {
    this.counters = {
      offline_queue_size: 0,
      sync_success_total: 0,
      sync_retry_total: 0,
      sync_conflict_total: 0,
      sync_permanent_failure_total: 0,
      idempotency_duplicate_total: 0,
      device_revocation_total: 0
    };
  }

  increment(metricName, count = 1) {
    if (this.counters[metricName] !== undefined) {
      this.counters[metricName] += count;
    }
  }

  setGauge(metricName, value) {
    if (this.counters[metricName] !== undefined) {
      this.counters[metricName] = value;
    }
  }

  getMetrics() {
    return { ...this.counters };
  }

  reset() {
    for (const key of Object.keys(this.counters)) {
      this.counters[key] = 0;
    }
  }

  /**
   * Sanitizes log payloads to prevent PII / secret leakage (INV-08-20)
   */
  static sanitizeLogPayload(payload) {
    if (!payload || typeof payload !== 'object') return {};
    const sanitized = { ...payload };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.apiKey;
    delete sanitized.apiToken;
    delete sanitized.secret;
    delete sanitized.phone;
    delete sanitized.customerPhone;
    delete sanitized.address;
    return sanitized;
  }
}

const globalMetrics = new OfflineMetrics();

module.exports = {
  OfflineMetrics,
  globalMetrics
};
