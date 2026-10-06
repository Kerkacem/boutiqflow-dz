/**
 * BoutiqFlow DZ — Integrations & Public API Subsystem Index
 */

const {
  PROVIDERS,
  SHOPIFY_API_VERSION,
  WOOCOMMERCE_API_PATH,
  PUBLIC_API_VERSION,
  INTEGRATION_STATUSES,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  API_SCOPES,
  INTEGRATION_ERRORS,
  OUTBOX_STATUSES
} = require('./constants');

const {
  encryptCredentials,
  decryptCredentials,
  hashSecret,
  signHmacSha256,
  verifyHmacSha256,
  computePayloadHash
} = require('./crypto_service');

const { BaseCommerceAdapter } = require('./adapters/base');
const { ShopifyGraphQLAdapter } = require('./adapters/shopify_graphql');
const { WooCommerceRestAdapter } = require('./adapters/woocommerce_rest');
const { IntegrationService } = require('./integration_service');
const { OrderImportService } = require('./order_import_service');
const { InventoryProjectionService } = require('./inventory_projection_service');
const { IntegrationOutboxService } = require('./integration_outbox');
const { PublicApiService } = require('./public_api_service');
const { WebhookDeliveryService } = require('./webhook_delivery_service');

module.exports = {
  PROVIDERS,
  SHOPIFY_API_VERSION,
  WOOCOMMERCE_API_PATH,
  PUBLIC_API_VERSION,
  INTEGRATION_STATUSES,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  API_SCOPES,
  INTEGRATION_ERRORS,
  OUTBOX_STATUSES,
  encryptCredentials,
  decryptCredentials,
  hashSecret,
  signHmacSha256,
  verifyHmacSha256,
  computePayloadHash,
  BaseCommerceAdapter,
  ShopifyGraphQLAdapter,
  WooCommerceRestAdapter,
  IntegrationService,
  OrderImportService,
  InventoryProjectionService,
  IntegrationOutboxService,
  PublicApiService,
  WebhookDeliveryService
};
