/**
 * BoutiqFlow DZ — Durable Local Outbox Queue (Phase 08)
 * Implements persistent IndexedDB-style queue, monotonic sequence tracking,
 * multi-tab recoverable leases (INV-08-22), crash survival (INV-08-05), and capability gating (INV-08-24).
 */

const fs = require('fs');
const { generateUUIDv7 } = require('../db/utils');
const {
  OFFLINE_OPERATIONS,
  CAPABILITY_MATRIX,
  OUTBOX_STATUSES
} = require('./constants');
const { computeRequestHash, createOperationId } = require('./operation_identity');

class LocalOutbox {
  constructor({ deviceId, tenantId, persistencePath = null } = {}) {
    this.deviceId = deviceId || 'POS-DEFAULT';
    this.tenantId = tenantId || null;
    this.persistencePath = persistencePath;
    this.sequenceNumber = 0;
    this.items = new Map(); // id -> OutboxItem
    this.opIdIndex = new Map(); // operationId -> id

    if (this.persistencePath && fs.existsSync(this.persistencePath)) {
      this.loadFromDisk();
    }
  }

  saveToDisk() {
    if (!this.persistencePath) return;
    const dump = {
      deviceId: this.deviceId,
      tenantId: this.tenantId,
      sequenceNumber: this.sequenceNumber,
      items: Array.from(this.items.entries())
    };
    const json = JSON.stringify(dump, (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v));
    fs.writeFileSync(this.persistencePath, json, 'utf8');
  }

  loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const json = fs.readFileSync(this.persistencePath, 'utf8');
      const dump = JSON.parse(json, (k, v) => (v && v.__bigint !== undefined ? BigInt(v.__bigint) : v));
      this.deviceId = dump.deviceId;
      this.tenantId = dump.tenantId;
      this.sequenceNumber = dump.sequenceNumber || 0;
      this.items = new Map(dump.items);
      this.opIdIndex.clear();
      for (const [id, item] of this.items) {
        this.opIdIndex.set(item.operationId, id);
      }
    } catch (e) {}
  }

  /**
   * Enqueues an operation into the durable outbox (INV-08-01, INV-08-24)
   */
  enqueueOperation({
    operationType,
    payload,
    operationId = null,
    dependsOnOperationId = null
  }) {
    // 1. Enforce Capability Matrix (INV-08-11, INV-08-24)
    if (!CAPABILITY_MATRIX[operationType]) {
      throw new Error(`Capability Violation: Operation '${operationType}' is strictly prohibited offline (INV-08-11, INV-08-24). Requires online connectivity.`);
    }

    // 2. Assign Monotonic Sequence Number
    this.sequenceNumber += 1;
    const finalOpId = operationId || createOperationId({ tenantId: this.tenantId, deviceId: this.deviceId, type: operationType });
    const requestHash = computeRequestHash(payload);

    // 3. Create Durable Outbox Record
    const id = generateUUIDv7();
    const outboxItem = {
      id,
      operationId: finalOpId,
      deviceId: this.deviceId,
      tenantId: this.tenantId,
      operationType,
      payload,
      requestHash,
      sequenceNumber: this.sequenceNumber,
      dependsOnOperationId,
      createdAt: new Date().toISOString(),
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
      status: OUTBOX_STATUSES.QUEUED,
      lastError: null,
      serverAck: null,
      processingOwner: null,
      leaseExpiresAt: null
    };

    this.items.set(id, outboxItem);
    this.opIdIndex.set(finalOpId, id);

    if (this.persistencePath) {
      this.saveToDisk();
    }

    return { ...outboxItem };
  }

  /**
   * Leases a batch of pending/retryable items for processing (Multi-tab safety INV-08-22)
   */
  claimBatch({ ownerId = 'tab_1', leaseDurationMs = 5000, limit = 10 } = {}) {
    const now = Date.now();
    const claimed = [];

    for (const [id, item] of this.items) {
      if (claimed.length >= limit) break;

      const isUnclaimed = item.status === OUTBOX_STATUSES.QUEUED || item.status === OUTBOX_STATUSES.RETRYABLE_FAILURE;
      const isLeaseExpired = item.status === OUTBOX_STATUSES.SENDING && item.leaseExpiresAt && now > item.leaseExpiresAt;

      if (isUnclaimed || isLeaseExpired) {
        item.status = OUTBOX_STATUSES.SENDING;
        item.processingOwner = ownerId;
        item.leaseExpiresAt = now + leaseDurationMs;
        item.attemptCount += 1;
        claimed.push({ ...item });
      }
    }

    if (this.persistencePath && claimed.length > 0) {
      this.saveToDisk();
    }

    return claimed;
  }

  /**
   * Releases un-acked leases back to QUEUED
   */
  releaseClaims(itemIds) {
    for (const id of itemIds) {
      const item = this.items.get(id);
      if (item && item.status === OUTBOX_STATUSES.SENDING) {
        item.status = OUTBOX_STATUSES.QUEUED;
        item.processingOwner = null;
        item.leaseExpiresAt = null;
      }
    }
    if (this.persistencePath) this.saveToDisk();
  }

  /**
   * Acknowledges successful server sync
   */
  ackOperation(operationId, serverAck) {
    const id = this.opIdIndex.get(operationId);
    if (!id) return null;
    const item = this.items.get(id);
    if (!item) return null;

    item.status = OUTBOX_STATUSES.ACKED;
    item.serverAck = serverAck;
    item.processingOwner = null;
    item.leaseExpiresAt = null;

    if (this.persistencePath) this.saveToDisk();
    return { ...item };
  }

  /**
   * Marks operation failure (retryable or permanent)
   */
  failOperation(operationId, { error, isRetryable = false, conflictCode = null }) {
    const id = this.opIdIndex.get(operationId);
    if (!id) return null;
    const item = this.items.get(id);
    if (!item) return null;

    item.lastError = {
      message: error ? error.message : 'Unknown error',
      code: error ? error.code : conflictCode,
      conflictCode,
      failedAt: new Date().toISOString()
    };

    if (conflictCode) {
      item.status = OUTBOX_STATUSES.CONFLICT;
    } else if (isRetryable) {
      item.status = OUTBOX_STATUSES.RETRYABLE_FAILURE;
    } else {
      item.status = OUTBOX_STATUSES.PERMANENT_FAILURE;
    }

    item.processingOwner = null;
    item.leaseExpiresAt = null;

    if (this.persistencePath) this.saveToDisk();
    return { ...item };
  }

  getItems() {
    return Array.from(this.items.values()).map(i => ({ ...i }));
  }

  getItem(operationId) {
    const id = this.opIdIndex.get(operationId);
    if (!id) return null;
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  getPendingCount() {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === OUTBOX_STATUSES.QUEUED || item.status === OUTBOX_STATUSES.SENDING || item.status === OUTBOX_STATUSES.RETRYABLE_FAILURE) {
        count++;
      }
    }
    return count;
  }

  clear() {
    this.items.clear();
    this.opIdIndex.clear();
    this.sequenceNumber = 0;
    if (this.persistencePath && fs.existsSync(this.persistencePath)) {
      fs.unlinkSync(this.persistencePath);
    }
  }
}

module.exports = {
  LocalOutbox
};
