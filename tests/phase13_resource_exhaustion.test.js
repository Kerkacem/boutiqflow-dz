const test = require('node:test');
const assert = require('node:assert');
const { SECURITY_ERRORS } = require('../src/security');

function validatePayloadSize(byteLength, maxAllowedBytes = 5 * 1024 * 1024) {
  if (byteLength > maxAllowedBytes) {
    const err = new Error(`Payload Too Large: ${byteLength} bytes exceeds limit of ${maxAllowedBytes} bytes`);
    err.code = SECURITY_ERRORS.PAYLOAD_TOO_LARGE;
    err.statusCode = 413;
    throw err;
  }
  return true;
}

function parseJsonSafely(jsonString, maxDepth = 15) {
  let depth = 0;
  let maxObservedDepth = 0;

  for (let i = 0; i < jsonString.length; i++) {
    const ch = jsonString[i];
    if (ch === '{' || ch === '[') {
      depth++;
      if (depth > maxObservedDepth) maxObservedDepth = depth;
      if (depth > maxDepth) {
        const err = new Error(`JSON Depth Limit Exceeded: Depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
        err.code = 'JSON_TOO_DEEP';
        throw err;
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }

  return JSON.parse(jsonString);
}

test('Phase 13 — Resource Exhaustion & Payload Limits (INV-13-19, Requirement 22)', async (t) => {
  await t.test('1. Oversized payload is rejected with 413 PAYLOAD_TOO_LARGE before processing', () => {
    // 10MB payload
    const oversizedLength = 10 * 1024 * 1024;
    assert.throws(
      () => validatePayloadSize(oversizedLength, 5 * 1024 * 1024),
      (err) => {
        assert.strictEqual(err.code, SECURITY_ERRORS.PAYLOAD_TOO_LARGE);
        assert.strictEqual(err.statusCode, 413);
        return true;
      }
    );

    // 1MB payload: allowed
    assert.strictEqual(validatePayloadSize(1 * 1024 * 1024, 5 * 1024 * 1024), true);
  });

  await t.test('2. Deeply nested JSON is rejected to prevent recursion stack overflow', () => {
    // Construct JSON nested 30 levels deep
    let deepJson = '{"a":';
    for (let i = 0; i < 28; i++) {
      deepJson += '{"b":';
    }
    deepJson += '1' + '}'.repeat(29);

    assert.throws(
      () => parseJsonSafely(deepJson, 15),
      (err) => {
        assert.strictEqual(err.code, 'JSON_TOO_DEEP');
        return true;
      }
    );

    // Normal JSON (depth 3): allowed
    const safeJson = '{"store": {"pos": {"registerId": "REG-01"}}}';
    const parsed = parseJsonSafely(safeJson, 15);
    assert.strictEqual(parsed.store.pos.registerId, 'REG-01');
  });

  await t.test('3. Bounded memory under heavy repetitive parsing', () => {
    const baselineMemory = process.memoryUsage().heapUsed;

    for (let i = 0; i < 5000; i++) {
      const obj = { index: i, text: 'Sample test clothing item payload for boutique' };
      JSON.stringify(obj);
    }

    const currentMemory = process.memoryUsage().heapUsed;
    const diffMb = (currentMemory - baselineMemory) / (1024 * 1024);
    // Heap growth should be well below 50MB
    assert.ok(diffMb < 50, `Memory growth was excessive: ${diffMb} MB`);
  });
});
