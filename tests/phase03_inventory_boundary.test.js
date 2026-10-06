const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { MahalDatabase } = require('../src/db/client');
const { generateUUIDv7 } = require('../src/db/utils');
const {
  receiveStock,
  issueStock,
  reserveStock,
  getVariantStock
} = require('../src/inventory/ledger');

test('Phase 03 — Inventory Architectural Boundary & Non-Direct Mutation (INV-03-13)', async (t) => {
  const db = new MahalDatabase();
  const tenantId = generateUUIDv7();
  let locationId;
  let variantId;

  await t.test('Setup tenant, location, and test variant', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const loc = await tx.insert('inventory_locations', { name: 'Boutique Alger Boundary' });
      locationId = loc.id;

      const p = await tx.insert('products', { name: 'Veste Boundary Guard' });
      const v = await tx.insert('product_variants', {
        product_id: p.id,
        sku: 'VST-BND-01',
        size: 'L',
        color: 'Gris',
        cost_price: 300000n,
        sale_price: 600000n
      });
      variantId = v.id;

      // Legitimate seed via authoritative InventoryService
      await receiveStock(tx, { variantId, locationId, quantity: 10 });
    });
  });

  await t.test('Runtime Enforcement: Direct insert to stock_levels outside InventoryService is BLOCKED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => {
          await tx.insert('stock_levels', {
            variant_id: variantId,
            location_id: locationId,
            on_hand: 999,
            reserved: 0,
            available: 999
          });
        },
        /Architectural Boundary Violation: Direct inventory table mutation is prohibited \(INV-03-13\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Direct update to stock_levels outside InventoryService is BLOCKED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const levels = await tx.query('stock_levels', l => l.variant_id === variantId);
      assert.ok(levels.length > 0);
      const levelId = levels[0].id;

      await assert.rejects(
        async () => {
          await tx.update('stock_levels', levelId, { on_hand: 100 });
        },
        /Architectural Boundary Violation: Direct inventory table mutation is prohibited \(INV-03-13\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Direct delete of stock_levels outside InventoryService is BLOCKED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const levels = await tx.query('stock_levels', l => l.variant_id === variantId);
      const levelId = levels[0].id;

      await assert.rejects(
        async () => {
          await tx.delete('stock_levels', levelId);
        },
        /Architectural Boundary Violation: Direct inventory table mutation is prohibited \(INV-03-13\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Direct insert to stock_movements outside InventoryService is BLOCKED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => {
          await tx.insert('stock_movements', {
            variant_id: variantId,
            location_id: locationId,
            qty: 50,
            type: 'SALE'
          });
        },
        /Architectural Boundary Violation: Direct inventory table mutation is prohibited \(INV-03-13\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Direct update/delete of stock_movements is STRICTLY PROHIBITED (INV-03-06)', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      const movements = await tx.query('stock_movements', m => m.variant_id === variantId);
      assert.ok(movements.length > 0);
      const movementId = movements[0].id;

      await assert.rejects(
        async () => {
          await tx.update('stock_movements', movementId, { qty: 0 });
        },
        /Ledger Violation: stock_movements are strictly immutable \(INV-03-06\)/
      );

      await assert.rejects(
        async () => {
          await tx.delete('stock_movements', movementId);
        },
        /Ledger Violation: stock_movements are strictly immutable \(INV-03-06\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Direct mutation of stock_reservations outside InventoryService is BLOCKED', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      await assert.rejects(
        async () => {
          await tx.insert('stock_reservations', {
            variant_id: variantId,
            location_id: locationId,
            qty: 5,
            status: 'ACTIVE'
          });
        },
        /Architectural Boundary Violation: Direct inventory table mutation is prohibited \(INV-03-13\)/
      );
    });
  });

  await t.test('Runtime Enforcement: Authoritative InventoryService succeeds with full authority', async () => {
    await db.withTenant({ tenantId }, async (tx) => {
      // Legitimate call via Inventory API succeeds
      const res = await reserveStock(tx, {
        variantId,
        locationId,
        quantity: 2
      });
      assert.ok(res.id);
      assert.strictEqual(res.reserved, 2);

      const issue = await issueStock(tx, {
        variantId,
        locationId,
        quantity: 1
      });
      assert.strictEqual(issue.onHand, 9); // 10 - 1 = 9
      assert.strictEqual(issue.reserved, 2);
      assert.strictEqual(issue.available, 7); // 9 - 2 = 7
    });
  });

  await t.test('Static Codebase Audit: Zero direct inventory mutations across all external domain modules', () => {
    const trackedFiles = cp.execSync('git ls-files src/').toString().trim().split('\n');
    const directMutationViolations = [];

    const forbiddenCalls = [
      /insert\s*\(\s*['"]stock_levels['"]/,
      /update\s*\(\s*['"]stock_levels['"]/,
      /delete\s*\(\s*['"]stock_levels['"]/,
      /insert\s*\(\s*['"]stock_movements['"]/,
      /update\s*\(\s*['"]stock_movements['"]/,
      /delete\s*\(\s*['"]stock_movements['"]/,
      /insert\s*\(\s*['"]stock_reservations['"]/,
      /update\s*\(\s*['"]stock_reservations['"]/,
      /delete\s*\(\s*['"]stock_reservations['"]/,
      /insert\s*\(\s*['"]stock_transfers['"]/,
      /update\s*\(\s*['"]stock_transfers['"]/,
      /delete\s*\(\s*['"]stock_transfers['"]/
    ];

    for (const file of trackedFiles) {
      if (file.endsWith('src/inventory/ledger.js') || file.endsWith('src/db/client.js')) {
        // Authoritative inventory engine files allowed
        continue;
      }
      const fullPath = path.resolve(process.cwd(), file);
      if (!fs.existsSync(fullPath)) continue;

      const code = fs.readFileSync(fullPath, 'utf8');
      const lines = code.split('\n');

      lines.forEach((line, idx) => {
        for (const pattern of forbiddenCalls) {
          if (pattern.test(line)) {
            directMutationViolations.push(`${file}:${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }

    assert.strictEqual(
      directMutationViolations.length,
      0,
      `Architectural boundary violated! Found direct inventory table mutations in non-inventory modules:\n${directMutationViolations.join('\n')}`
    );
  });
});
