const test = require('node:test');
const assert = require('node:assert');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');

test('Phase 13 — Database Failure, Disconnection & Degraded Modes (INV-13-08, Requirement 24)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();

  await t.test('1. Database transaction rollback on connection failure never swallows errors or reports false success (Requirement 24)', async () => {
    let operationAttempted = false;

    await assert.rejects(
      async () => {
        await db.withTenant({ tenantId }, async (tx) => {
          await tx.insert('products', { name: 'Robe Blanche' });
          operationAttempted = true;
          // Simulate sudden database socket disconnection / connection reset
          const dbErr = new Error('ECONNRESET: Database connection closed by remote peer');
          dbErr.code = 'ECONNRESET';
          throw dbErr;
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'ECONNRESET');
        return true;
      }
    );

    assert.strictEqual(operationAttempted, true);

    // Verify database contains zero partial records
    await db.withTenant({ tenantId }, async (tx) => {
      const records = await tx.query('products', p => p.name === 'Robe Blanche');
      assert.strictEqual(records.length, 0);
    });
  });

  await t.test('2. Rolled back transaction rejects further queries or commits', async () => {
    await assert.rejects(
      async () => {
        await db.withTenant({ tenantId }, async (tx) => {
          await tx.rollback();
          // Attempting query after rollback
          await tx.query('products', () => true);
        });
      },
      /Transaction has been rolled back/
    );
  });
});
