/**
 * CostingService — Centralized inventory costing abstraction for BoutiqFlow DZ
 * Supports:
 * - Moving Weighted Average Cost (WAC) (Default)
 * - Extensible strategy interface for future FIFO
 * 
 * Invariants:
 * - INV-05-04: Every received quantity has an auditable cost snapshot.
 * - INV-05-05: Historical sale cost snapshot never changes.
 * - INV-05-06: Historical COGS never changes because of current catalog cost.
 */

const COSTING_STRATEGIES = {
  WEIGHTED_AVERAGE: 'WEIGHTED_AVERAGE',
  FIFO: 'FIFO'
};

class CostingService {
  constructor(strategy = COSTING_STRATEGIES.WEIGHTED_AVERAGE) {
    this.strategy = strategy;
  }

  /**
   * Calculate new moving weighted average cost in centimes
   * @param {Object} params
   * @param {number} params.existingQty - current on-hand quantity across locations
   * @param {bigint|number} params.existingCostCentimes - current variant cost price
   * @param {number} params.incomingQty - new received quantity
   * @param {bigint|number} params.incomingCostCentimes - unit purchase cost in centimes
   * @returns {bigint} new weighted average cost in centimes
   */
  calculateWeightedAverageCost({ existingQty, existingCostCentimes, incomingQty, incomingCostCentimes }) {
    const inQty = Number(incomingQty);
    if (!Number.isInteger(inQty) || inQty <= 0) {
      throw new Error('Validation Error: Incoming quantity must be a strictly positive integer');
    }

    const inCost = BigInt(incomingCostCentimes);
    if (inCost < 0n) {
      throw new Error('Validation Error: Incoming unit cost cannot be negative');
    }

    const exQty = Number(existingQty || 0);
    const exCost = BigInt(existingCostCentimes || 0n);

    // If existing physical stock is zero or negative, the new average cost is the incoming cost
    if (exQty <= 0) {
      return inCost;
    }

    const totalQty = BigInt(exQty + inQty);
    const totalValue = (BigInt(exQty) * exCost) + (BigInt(inQty) * inCost);

    return totalValue / totalQty;
  }

  /**
   * Apply cost update when goods are received
   * @param {TenantTransaction} tx
   * @param {Object} params
   * @param {string} params.variantId
   * @param {number} params.incomingQty
   * @param {bigint|number} params.incomingUnitCostCentimes
   * @returns {Promise<{ variantId: string, previousCostCentimes: bigint, newCostCentimes: bigint, totalOnHand: number, incomingQty: number, incomingUnitCostCentimes: bigint }>}
   */
  async applyReceiptCost(tx, { variantId, incomingQty, incomingUnitCostCentimes }) {
    const variant = await tx.findById('product_variants', variantId);
    if (!variant) {
      throw new Error(`Variant not found: ${variantId}`);
    }

    // Determine total physical on-hand quantity for this variant across all tenant locations
    const stockLevels = await tx.query('stock_levels', l => l.variant_id === variantId);
    const totalOnHand = stockLevels.reduce((sum, lvl) => sum + (lvl.on_hand || 0), 0);

    const previousCostCentimes = BigInt(variant.cost_price || 0n);
    let newCostCentimes = previousCostCentimes;

    if (this.strategy === COSTING_STRATEGIES.WEIGHTED_AVERAGE) {
      newCostCentimes = this.calculateWeightedAverageCost({
        existingQty: totalOnHand,
        existingCostCentimes: previousCostCentimes,
        incomingQty,
        incomingCostCentimes: incomingUnitCostCentimes
      });
    } else {
      newCostCentimes = this.calculateWeightedAverageCost({
        existingQty: totalOnHand,
        existingCostCentimes: previousCostCentimes,
        incomingQty,
        incomingCostCentimes: incomingUnitCostCentimes
      });
    }

    // Update variant's current catalog cost price to the new weighted average
    await tx.update('product_variants', variantId, {
      cost_price: newCostCentimes
    });

    return {
      variantId,
      previousCostCentimes,
      newCostCentimes,
      totalOnHand,
      incomingQty,
      incomingUnitCostCentimes: BigInt(incomingUnitCostCentimes)
    };
  }
}

const defaultCostingService = new CostingService(COSTING_STRATEGIES.WEIGHTED_AVERAGE);

module.exports = {
  COSTING_STRATEGIES,
  CostingService,
  defaultCostingService
};
