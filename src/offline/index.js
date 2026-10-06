/**
 * BoutiqFlow DZ — Offline Domain Unified Index (Phase 08)
 */

const constants = require('./constants');
const operationIdentity = require('./operation_identity');
const { DeviceService } = require('./device_service');
const { StockAllowanceService } = require('./stock_allowance');
const { LocalOutbox } = require('./local_outbox');
const { SyncEngine } = require('./sync_engine');
const { ConflictService } = require('./conflict_service');
const { OfflineReceiptEngine } = require('./offline_receipt');
const { OfflineMetrics, globalMetrics } = require('./metrics');

module.exports = {
  ...constants,
  ...operationIdentity,
  DeviceService,
  StockAllowanceService,
  LocalOutbox,
  SyncEngine,
  ConflictService,
  OfflineReceiptEngine,
  OfflineMetrics,
  globalMetrics
};
