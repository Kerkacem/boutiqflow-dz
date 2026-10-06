/**
 * BoutiqFlow DZ — Delivery Domain Index (Phase 07)
 * Unified delivery providers, shipment lifecycle, and reconciliation entry point.
 */

const constants = require('./constants');
const geoReference = require('./geo_reference');
const encryption = require('./encryption');
const errors = require('./errors');
const retry = require('./retry');
const { BaseDeliveryAdapter } = require('./adapter');
const { YalidineAdapter } = require('./adapters/yalidine');
const { ZrExpressAdapter } = require('./adapters/zr_express');
const { NoestAdapter } = require('./adapters/noest');
const { MaystroAdapter } = require('./adapters/maystro');
const { GenericDeliveryProvider } = require('./adapters/generic');
const { FakeDeliveryProvider, ProviderSandboxAdapter } = require('./adapters/sandbox');
const { ShipmentService } = require('./shipment_service');
const { ShipmentEventProcessor } = require('./event_processor');
const { ShipmentReturnService } = require('./returns_service');
const { DeliveryReconciliationService } = require('./reconciliation_service');
const { DeliveryRateService } = require('./rate_service');

module.exports = {
  ...constants,
  ...geoReference,
  ...encryption,
  ...errors,
  ...retry,
  BaseDeliveryAdapter,
  YalidineAdapter,
  ZrExpressAdapter,
  NoestAdapter,
  MaystroAdapter,
  GenericDeliveryProvider,
  FakeDeliveryProvider,
  ProviderSandboxAdapter,
  ShipmentService,
  ShipmentEventProcessor,
  ShipmentReturnService,
  DeliveryReconciliationService,
  DeliveryRateService
};
