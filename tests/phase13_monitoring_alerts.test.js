const test = require('node:test');
const assert = require('node:assert');
const {
  MonitoringAlertService,
  SEVERITY_LEVELS
} = require('../src/security');

test('Phase 13 — Monitoring Alerts, Sanitization & Correlation IDs (INV-13-24, INV-13-29, Requirements 43-46)', async (t) => {
  const monitoring = new MonitoringAlertService();

  await t.test('1. Security events strictly sanitize passwords, tokens and secrets (INV-13-24, Requirement 44)', () => {
    const rawDetails = {
      email: 'attacker@evil.dz',
      password: 'SuperSecretPassword123!',
      apiKey: 'sk_live_998877665544332211',
      sessionToken: 'tok_active_session_abc',
      card_number: '4111222233334444'
    };

    const event = monitoring.recordSecurityEvent({
      tenantId: 'tenant_test_1',
      actorId: 'usr_attacker',
      action: 'FAILED_AUTHENTICATION_BURST',
      result: 'BLOCKED',
      severity: SEVERITY_LEVELS.P1_HIGH,
      details: rawDetails
    });

    assert.ok(event.id);
    assert.strictEqual(event.details.password, '[REDACTED_SECRET]');
    assert.strictEqual(event.details.apiKey, '[REDACTED_SECRET]');
    assert.strictEqual(event.details.card_number, '[REDACTED_SECRET]');
    assert.strictEqual(event.details.email, 'attacker@evil.dz');
  });

  await t.test('2. Critical Security Anomalies trigger real-time alerts (Requirement 45)', () => {
    monitoring.clear();

    // 15 repeated failed login attempts trigger high-severity alert
    for (let i = 1; i <= 15; i++) {
      monitoring.recordSecurityEvent({
        action: 'BRUTE_FORCE_LOGIN_ATTEMPT',
        result: 'BLOCKED',
        severity: i === 15 ? SEVERITY_LEVELS.P0_CRITICAL : SEVERITY_LEVELS.P2_MEDIUM,
        correlationId: 'CORR-ATTACK-001',
        details: { attemptNumber: i, sourceIp: '197.200.1.99' }
      });
    }

    const criticalAlerts = monitoring.getAlerts({ severity: SEVERITY_LEVELS.P0_CRITICAL });
    assert.strictEqual(criticalAlerts.length, 1);
    assert.strictEqual(criticalAlerts[0].action, 'BRUTE_FORCE_LOGIN_ATTEMPT');
    assert.strictEqual(criticalAlerts[0].correlationId, 'CORR-ATTACK-001');
  });

  await t.test('3. Cross-Subsystem Traceability via Correlation ID (Requirement 46)', () => {
    const sharedCorrelationId = 'CORR-TRACE-ORDER-777';

    // Step 1: Inbound Webhook
    const ev1 = monitoring.recordSecurityEvent({
      action: 'WEBHOOK_RECEIVED',
      correlationId: sharedCorrelationId,
      details: { topic: 'order.created' }
    });

    // Step 2: Stock Reservation
    const ev2 = monitoring.recordSecurityEvent({
      action: 'STOCK_RESERVED',
      correlationId: sharedCorrelationId,
      details: { orderId: 'ORD-777' }
    });

    // Step 3: Courier Dispatch
    const ev3 = monitoring.recordSecurityEvent({
      action: 'SHIPMENT_DISPATCHED',
      correlationId: sharedCorrelationId,
      details: { trackingNumber: 'YAL-777' }
    });

    // All events link back to the identical correlationId
    assert.strictEqual(ev1.correlationId, sharedCorrelationId);
    assert.strictEqual(ev2.correlationId, sharedCorrelationId);
    assert.strictEqual(ev3.correlationId, sharedCorrelationId);
  });
});
