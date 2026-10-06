/**
 * BoutiqFlow DZ — POS Device Identity & Revocation Service (INV-08-17, INV-08-23)
 * Manages tenant-bound hardware identities, authorization, and administrative revocation.
 */

const { generateUUIDv7 } = require('../db/utils');
const { DEVICE_STATUSES } = require('./constants');

class DeviceService {
  /**
   * Registers a new physical or browser POS device bound to a tenant
   */
  static async registerDevice(tx, {
    registerId,
    name = 'POS Terminal',
    deviceId = null,
    metadata = {}
  }) {
    const tenantId = tx.session.tenantId;
    const finalDeviceId = deviceId || `dev_${generateUUIDv7()}`;

    // Check if device already exists
    const existing = await tx.query('devices', d => d.id === finalDeviceId || (d.tenant_id === tenantId && d.device_id === finalDeviceId));
    if (existing.length > 0) {
      return existing[0];
    }

    const deviceRecord = {
      id: finalDeviceId,
      device_id: finalDeviceId,
      tenant_id: tenantId,
      register_id: registerId,
      name,
      status: DEVICE_STATUSES.ACTIVE,
      metadata,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    };

    return await tx.insert('devices', deviceRecord);
  }

  /**
   * Authoritatively revokes a compromised, lost, or decommissioned device (INV-08-17)
   */
  static async revokeDevice(tx, {
    deviceId,
    revokedBy = 'admin',
    reason = 'Administrative security revocation'
  }) {
    const tenantId = tx.session.tenantId;
    const devices = await tx.query('devices', d => d.tenant_id === tenantId && (d.id === deviceId || d.device_id === deviceId));
    if (devices.length === 0) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    const device = devices[0];
    const updated = await tx.update('devices', device.id, {
      status: DEVICE_STATUSES.REVOKED,
      revoked_at: new Date().toISOString(),
      revoked_by: revokedBy,
      revocation_reason: reason
    });

    // Record security audit event
    await tx.insert('audit_logs', {
      action: 'DEVICE_REVOKED',
      actor_id: revokedBy,
      entity_type: 'device',
      entity_id: device.id,
      details: { reason, deviceName: device.name, registerId: device.register_id },
      created_at: new Date().toISOString()
    });

    return updated;
  }

  /**
   * Verifies device status and tenant binding during sync (INV-08-09, INV-08-17, INV-08-23)
   */
  static async verifyDevice(tx, { deviceId }) {
    const tenantId = tx.session.tenantId;

    // Check direct table to explicitly catch and report cross-tenant penetration attempts
    if (tx.db && tx.db.tables && tx.db.tables.devices) {
      const rawDevice = tx.db.tables.devices.get(deviceId);
      if (rawDevice && rawDevice.tenant_id !== tenantId) {
        const err = new Error('Security Violation: Device belongs to another tenant (INV-08-09, INV-08-23)');
        err.code = 'TENANT_MISMATCH';
        throw err;
      }
    }

    const devices = await tx.query('devices', d => (d.id === deviceId || d.device_id === deviceId));
    if (devices.length === 0) {
      const err = new Error(`Device not found: ${deviceId}`);
      err.code = 'DEVICE_NOT_FOUND';
      throw err;
    }

    const device = devices[0];
    if (device.tenant_id !== tenantId) {
      const err = new Error('Security Violation: Device belongs to another tenant (INV-08-09, INV-08-23)');
      err.code = 'TENANT_MISMATCH';
      throw err;
    }

    if (device.status === DEVICE_STATUSES.REVOKED) {
      const err = new Error(`Device ${deviceId} has been revoked and cannot perform mutations (INV-08-17)`);
      err.code = 'DEVICE_REVOKED';
      throw err;
    }

    // Update last_seen_at
    await tx.update('devices', device.id, { last_seen_at: new Date().toISOString() });
    return device;
  }
}

module.exports = {
  DeviceService
};
