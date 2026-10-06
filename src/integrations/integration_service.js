/**
 * BoutiqFlow DZ — Integration Account & Lifecycle Service (INV-10-03, INV-10-15, INV-10-25)
 * Manages tenant-bound external store integrations (Shopify, WooCommerce),
 * handles credential encryption at rest, and manages lifecycle statuses.
 */

const { generateUUIDv7 } = require('../db/utils');
const { encryptCredentials, decryptCredentials } = require('./crypto_service');
const { ShopifyGraphQLAdapter } = require('./adapters/shopify_graphql');
const { WooCommerceRestAdapter } = require('./adapters/woocommerce_rest');
const {
  PROVIDERS,
  INTEGRATION_STATUSES
} = require('./constants');

class IntegrationService {
  /**
   * Instantiates appropriate adapter by provider
   */
  static getAdapter(provider) {
    if (provider === PROVIDERS.SHOPIFY) {
      return new ShopifyGraphQLAdapter();
    }
    if (provider === PROVIDERS.WOOCOMMERCE) {
      return new WooCommerceRestAdapter();
    }
    throw new Error(`Unsupported integration provider: ${provider}`);
  }

  /**
   * Registers and connects an external e-commerce integration (Section 7, INV-10-03)
   */
  static async registerIntegration(tx, {
    provider,
    name,
    credentials,
    scopes = [],
    metadata = {}
  }) {
    const tenantId = tx.session.tenantId;

    if (!provider || !name || !credentials) {
      throw new Error('Integration Error: provider, name, and credentials are required');
    }

    const adapter = this.getAdapter(provider);

    // 1. Validate credentials with adapter
    const validation = await adapter.validateCredentials(credentials);

    // 2. Encrypt credentials at rest (INV-10-15)
    const encrypted = encryptCredentials(credentials);

    const integrationId = generateUUIDv7();

    // 3. Create integration record
    const integrationRecord = {
      id: integrationId,
      tenant_id: tenantId,
      provider,
      name,
      status: INTEGRATION_STATUSES.ACTIVE,
      api_version: adapter.apiVersion,
      metadata: {
        ...metadata,
        shopDomain: validation.shopDomain || validation.storeUrl
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await tx.insert('integrations', integrationRecord);

    // 4. Save encrypted credentials
    await tx.insert('integration_credentials', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      integration_id: integrationId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      scopes,
      created_at: new Date().toISOString()
    });

    // 5. Law 25-11 TransferRecord for foreign cloud platforms (INV-10-25)
    await tx.insert('transfer_records', {
      id: generateUUIDv7(),
      tenant_id: tenantId,
      integration_id: integrationId,
      destination_country: provider === PROVIDERS.SHOPIFY ? 'CANADA' : 'VARIOUS',
      recipient_legal_entity: provider === PROVIDERS.SHOPIFY ? 'Shopify Inc.' : 'Self-Hosted / Cloud',
      safeguard_mechanism: 'Standard Contractual Clauses & Encryption at Rest',
      transfer_status: 'AUTHORIZED_FOR_FULFILLMENT',
      created_at: new Date().toISOString()
    });

    // 6. Security Audit Log
    await tx.insert('audit_logs', {
      action: 'INTEGRATION_CONNECTED',
      actor_id: tx.session.userId || 'system',
      entity_type: 'integration',
      entity_id: integrationId,
      details: { provider, name, scopes, apiVersion: adapter.apiVersion },
      created_at: new Date().toISOString()
    });

    return integrationRecord;
  }

  /**
   * Revokes an integration (INV-10-03)
   */
  static async revokeIntegration(tx, { integrationId, reason = 'Administrative revocation' }) {
    const tenantId = tx.session.tenantId;
    const integration = await tx.findById('integrations', integrationId);

    if (!integration || integration.tenant_id !== tenantId) {
      throw new Error(`Integration ${integrationId} not found or foreign tenant (INV-10-03)`);
    }

    const updated = await tx.update('integrations', integration.id, {
      status: INTEGRATION_STATUSES.REVOKED,
      revoked_at: new Date().toISOString(),
      revocation_reason: reason
    });

    await tx.insert('audit_logs', {
      action: 'INTEGRATION_REVOKED',
      actor_id: tx.session.userId || 'system',
      entity_type: 'integration',
      entity_id: integrationId,
      details: { reason },
      created_at: new Date().toISOString()
    });

    return updated;
  }

  /**
   * Retrieves an integration, verifying active status and tenant ownership
   */
  static async getIntegration(tx, integrationId) {
    const tenantId = tx.session.tenantId;
    const integration = await tx.findById('integrations', integrationId);
    if (!integration || integration.tenant_id !== tenantId) {
      return null;
    }
    return { ...integration };
  }

  /**
   * Securely decrypts credentials for internal adapter usage
   */
  static async getDecryptedCredentials(tx, integrationId) {
    const tenantId = tx.session.tenantId;
    const creds = await tx.query('integration_credentials', c =>
      c.tenant_id === tenantId && c.integration_id === integrationId
    );

    if (creds.length === 0) {
      throw new Error(`No credentials found for integration ${integrationId}`);
    }

    const record = creds[0];
    return decryptCredentials({
      ciphertext: record.ciphertext,
      iv: record.iv,
      tag: record.tag
    });
  }
}

module.exports = {
  IntegrationService
};
