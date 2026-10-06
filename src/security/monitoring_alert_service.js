/**
 * BoutiqFlow DZ — Security Monitoring & Real-time Alerting Engine (INV-13-24, INV-13-29, Requirements 43-46)
 * Generates structured security logs and fires prioritized alerts for critical anomalies,
 * strictly scrubbing passwords, session tokens, and unnecessary PII.
 */

const crypto = require('crypto');
const { SEVERITY_LEVELS } = require('./constants');

class MonitoringAlertService {
  constructor() {
    this.alerts = [];
    this.auditEvents = [];
  }

  /**
   * Records a sanitized security event with correlation tracking (Requirement 44 & 46)
   */
  recordSecurityEvent({
    tenantId = 'system',
    actorId = 'anonymous',
    action,
    result = 'BLOCKED',
    severity = SEVERITY_LEVELS.P2_MEDIUM,
    source = 'API_GATEWAY',
    correlationId = null,
    details = {}
  }) {
    const eventId = `SEC-${crypto.randomUUID().slice(0, 8)}`;
    const effectiveCorrelationId = correlationId || `CORR-${crypto.randomUUID().slice(0, 8)}`;

    // Strict PII & secret scrubbing (INV-13-24)
    const sanitizedDetails = this._sanitizeDetails(details);

    const event = {
      id: eventId,
      timestamp: new Date().toISOString(),
      tenantId,
      actorId,
      action,
      result,
      severity,
      source,
      correlationId: effectiveCorrelationId,
      details: sanitizedDetails
    };

    this.auditEvents.push(event);

    // Trigger immediate alert if P0 or P1 severity
    if (severity === SEVERITY_LEVELS.P0_CRITICAL || severity === SEVERITY_LEVELS.P1_HIGH) {
      this._dispatchAlert(event);
    }

    return event;
  }

  _dispatchAlert(event) {
    const alertId = `ALT-${crypto.randomUUID().slice(0, 8)}`;
    const alert = {
      id: alertId,
      severity: event.severity,
      title: `SECURITY ALERT: ${event.action} (${event.result})`,
      action: event.action,
      tenantId: event.tenantId,
      correlationId: event.correlationId,
      triggeredAt: event.timestamp,
      details: event.details
    };
    this.alerts.push(alert);
    return alert;
  }

  _sanitizeDetails(details) {
    const forbiddenKeys = ['password', 'token', 'secret', 'apikey', 'authorization', 'cvv', 'pan', 'card_number'];
    const sanitized = {};

    for (const [k, v] of Object.entries(details)) {
      const lower = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (forbiddenKeys.some(f => lower.includes(f.replace(/[^a-z0-9]/g, '')))) {
        sanitized[k] = '[REDACTED_SECRET]';
      } else if (typeof v === 'object' && v !== null) {
        sanitized[k] = this._sanitizeDetails(v);
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }

  getAlerts({ severity = null, tenantId = null } = {}) {
    return this.alerts.filter(a =>
      (!severity || a.severity === severity) &&
      (!tenantId || a.tenantId === tenantId)
    );
  }

  clear() {
    this.alerts = [];
    this.auditEvents = [];
  }
}

const defaultMonitoring = new MonitoringAlertService();

module.exports = {
  MonitoringAlertService,
  defaultMonitoring
};
