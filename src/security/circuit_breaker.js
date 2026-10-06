/**
 * BoutiqFlow DZ — Circuit Breaker Engine (INV-13-08, Requirement 49)
 * Protects system workers against external provider storm outages (couriers, Shopify, webhooks).
 * Implements CLOSED -> OPEN -> HALF_OPEN state machine with bounded recovery.
 */

const { CIRCUIT_STATES, SECURITY_ERRORS } = require('./constants');

class CircuitBreaker {
  constructor({
    name,
    failureThreshold = 5,
    resetTimeoutMs = 10000,
    halfOpenSuccessThreshold = 2
  }) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenSuccessThreshold = halfOpenSuccessThreshold;

    this.state = CIRCUIT_STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.nextAttemptAt = 0;
  }

  /**
   * Executes an asynchronous operation through the circuit breaker boundary
   */
  async execute(actionFn) {
    const now = Date.now();

    // Check if OPEN state has expired and can transition to HALF_OPEN
    if (this.state === CIRCUIT_STATES.OPEN) {
      if (now >= this.nextAttemptAt) {
        this.state = CIRCUIT_STATES.HALF_OPEN;
        this.halfOpenSuccesses = 0;
      } else {
        const err = new Error(`Circuit Breaker '${this.name}' is OPEN. Outbound call rejected fast to prevent worker storm`);
        err.code = SECURITY_ERRORS.CIRCUIT_OPEN;
        err.breaker = this.name;
        err.retryAfterMs = this.nextAttemptAt - now;
        throw err;
      }
    }

    try {
      const result = await actionFn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.state = CIRCUIT_STATES.CLOSED;
        this.consecutiveFailures = 0;
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  _onFailure(error) {
    this.consecutiveFailures++;

    if (this.state === CIRCUIT_STATES.HALF_OPEN || this.consecutiveFailures >= this.failureThreshold) {
      this.state = CIRCUIT_STATES.OPEN;
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      nextAttemptAt: this.nextAttemptAt
    };
  }

  reset() {
    this.state = CIRCUIT_STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.nextAttemptAt = 0;
  }
}

module.exports = {
  CircuitBreaker
};
