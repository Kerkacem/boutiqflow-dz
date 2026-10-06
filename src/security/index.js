/**
 * BoutiqFlow DZ — Security, Reliability & Disaster Recovery Unified Exports (Phase 13)
 */

const constants = require('./constants');
const { KeyManagementService, defaultKeyManager } = require('./key_management_service');
const { PostgresPatchValidator, SAFE_MINIMUM_VERSIONS } = require('./postgres_patch_validator');
const { IntegrityCheckJob } = require('./data_integrity_engine');
const { DeadLetterQueueService, defaultDLQ } = require('./dead_letter_queue');
const { CircuitBreaker } = require('./circuit_breaker');
const { BackupRecoveryService } = require('./backup_recovery_service');
const { MonitoringAlertService, defaultMonitoring } = require('./monitoring_alert_service');

module.exports = {
  ...constants,
  KeyManagementService,
  defaultKeyManager,
  PostgresPatchValidator,
  SAFE_MINIMUM_VERSIONS,
  IntegrityCheckJob,
  DeadLetterQueueService,
  defaultDLQ,
  CircuitBreaker,
  BackupRecoveryService,
  MonitoringAlertService,
  defaultMonitoring
};
