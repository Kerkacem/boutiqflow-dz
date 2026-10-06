/**
 * BoutiqFlow DZ — Delivery Bounded Retry Policy (INV-07-17)
 * Implements exponential backoff with jitter for retryable provider failures.
 */

const { DeliveryError } = require('./errors');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executes an async operation with bounded exponential backoff
 */
async function executeWithRetry(operationFn, options = {}) {
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
  const baseDelayMs = options.baseDelayMs !== undefined ? options.baseDelayMs : 50;
  const maxDelayMs = options.maxDelayMs !== undefined ? options.maxDelayMs : 500;
  const onRetry = options.onRetry || null;

  let attempt = 0;

  while (true) {
    try {
      return await operationFn(attempt);
    } catch (err) {
      attempt++;

      // Check if error is retryable
      const isRetryable = Boolean(
        err.isRetryable ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        err.status === 429 ||
        (err.status >= 500 && err.status <= 599)
      );

      if (!isRetryable || attempt > maxRetries) {
        throw err;
      }

      // Calculate exponential backoff with jitter
      const expDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 25);
      const delay = Math.min(maxDelayMs, expDelay + jitter);

      if (typeof onRetry === 'function') {
        onRetry({
          attempt,
          maxRetries,
          delayMs: delay,
          error: err
        });
      }

      await sleep(delay);
    }
  }
}

module.exports = {
  executeWithRetry
};
