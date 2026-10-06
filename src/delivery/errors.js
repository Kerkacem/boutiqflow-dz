/**
 * BoutiqFlow DZ — Delivery Canonical Error Taxonomy (INV-07-16)
 * Normalized error models with zero secret leakage.
 */

const { DELIVERY_ERROR_CODES } = require('./constants');

class DeliveryError extends Error {
  constructor(message, {
    code = DELIVERY_ERROR_CODES.UNKNOWN_PROVIDER_ERROR,
    provider = null,
    isRetryable = false,
    providerErrorCode = null,
    providerErrorMessage = null,
    details = null
  } = {}) {
    // Sanitize message to prevent token/key leakage (INV-07-16)
    const sanitizedMsg = String(message).replace(/([a-zA-Z0-9_\-]{20,})/g, '***');
    super(sanitizedMsg);
    this.name = 'DeliveryError';
    this.code = code;
    this.provider = provider;
    this.isRetryable = Boolean(isRetryable);
    this.providerErrorCode = providerErrorCode;
    this.providerErrorMessage = providerErrorMessage ? String(providerErrorMessage).replace(/([a-zA-Z0-9_\-]{20,})/g, '***') : null;
    this.details = details;
  }
}

class AuthenticationError extends DeliveryError {
  constructor(provider, message = 'Authentication failed with delivery provider', details = {}) {
    const formatted = message.toLowerCase().includes('authentication')
      ? message
      : `Authentication failed: ${message}`;
    super(formatted, {
      code: DELIVERY_ERROR_CODES.AUTHENTICATION_FAILED,
      provider,
      isRetryable: false,
      ...details
    });
    this.name = 'AuthenticationError';
  }
}

class ProviderTimeoutError extends DeliveryError {
  constructor(provider, message = 'Delivery provider request timed out', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.PROVIDER_TIMEOUT,
      provider,
      isRetryable: true,
      ...details
    });
    this.name = 'ProviderTimeoutError';
  }
}

class ProviderUnavailableError extends DeliveryError {
  constructor(provider, message = 'Delivery provider service is temporarily unavailable', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      provider,
      isRetryable: true,
      ...details
    });
    this.name = 'ProviderUnavailableError';
  }
}

class RateLimitError extends DeliveryError {
  constructor(provider, message = 'Delivery provider rate limit exceeded', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.RATE_LIMITED,
      provider,
      isRetryable: true,
      ...details
    });
    this.name = 'RateLimitError';
  }
}

class DuplicateShipmentError extends DeliveryError {
  constructor(provider, message = 'Duplicate shipment already exists on provider', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.DUPLICATE_SHIPMENT,
      provider,
      isRetryable: false,
      ...details
    });
    this.name = 'DuplicateShipmentError';
  }
}

class ShipmentNotFoundError extends DeliveryError {
  constructor(provider, message = 'Shipment not found on provider system', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.SHIPMENT_NOT_FOUND,
      provider,
      isRetryable: false,
      ...details
    });
    this.name = 'ShipmentNotFoundError';
  }
}

class ProviderValidationError extends DeliveryError {
  constructor(provider, message = 'Validation error returned by delivery provider', details = {}) {
    super(message, {
      code: DELIVERY_ERROR_CODES.PROVIDER_VALIDATION_ERROR,
      provider,
      isRetryable: false,
      ...details
    });
    this.name = 'ProviderValidationError';
  }
}

module.exports = {
  DeliveryError,
  AuthenticationError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitError,
  DuplicateShipmentError,
  ShipmentNotFoundError,
  ProviderValidationError
};
