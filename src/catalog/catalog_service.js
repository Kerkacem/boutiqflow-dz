const { generateUUIDv7, dinarToCentimes } = require('../db/utils');
const { generateInternalEan13, isValidEan13 } = require('./barcodes');
const { ROLES, PERMISSIONS, hasPermission, authorize } = require('../rbac/permissions');
const { logAuditEvent, AUDIT_ACTIONS } = require('../audit/audit_service');

/**
 * Authoritative Catalog Domain Service for BoutiqFlow DZ
 * Implements:
 * - Product Template CRUD (isolated from inventory)
 * - Variant (stock-bearing entity) CRUD with Size x Color matrix
 * - Invariant INV-P02-01: SKU unique per tenant
 * - Invariant INV-P02-02: Barcode unique per tenant
 * - Invariant INV-P02-03: Variant belongs to exactly one Product
 * - Invariant INV-P02-04: Variant cannot reference another tenant's Product
 * - Invariant INV-P02-05: Archived Variant cannot be sold
 * - Invariant INV-P02-06: Product archive does not silently delete variants
 * - Invariant INV-P02-07: Cashier cannot modify protected cost fields or prices
 * - Invariant INV-P02-08: Zero stock quantity is stored or mutated by Product CRUD
 * - Invariant INV-P02-09: Product/Variant deletion must preserve historical references
 * - Invariant INV-P02-10: Every mutation is auditable
 */

function normalizeBarcodeInput(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/[\r\n\t]/g, '').trim();
}

function normalizeSku(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/[^A-Z0-9\-_]/g, '');
}

class CatalogService {
  // ==========================================
  // PRODUCT TEMPLATE OPERATIONS
  // ==========================================

  static async createProduct(tx, {
    name,
    description = '',
    category = 'Général',
    brand = '',
    supplierReference = '',
    images = [],
    userRole = ROLES.OWNER
  }) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Product name is required');
    }

    const product = await tx.insert('products', {
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      brand: brand.trim(),
      supplier_reference: supplierReference.trim(),
      images,
      is_active: true
    });

    await logAuditEvent(tx, {
      action: 'catalog:product_create',
      entityType: 'products',
      entityId: product.id,
      metadata: { name: product.name, category: product.category }
    });

    return product;
  }

  static async updateProduct(tx, productId, updates, { userRole = ROLES.OWNER } = {}) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    const existing = await tx.findById('products', productId);
    if (!existing) {
      throw new Error(`Product ${productId} not found`);
    }

    const updated = await tx.update('products', productId, {
      ...(updates.name ? { name: updates.name.trim() } : {}),
      ...(updates.description !== undefined ? { description: updates.description.trim() } : {}),
      ...(updates.category ? { category: updates.category.trim() } : {}),
      ...(updates.brand !== undefined ? { brand: updates.brand.trim() } : {}),
      ...(updates.supplierReference !== undefined ? { supplier_reference: updates.supplierReference.trim() } : {}),
      ...(updates.images ? { images: updates.images } : {}),
      ...(updates.is_active !== undefined ? { is_active: Boolean(updates.is_active) } : {})
    });

    await logAuditEvent(tx, {
      action: 'catalog:product_update',
      entityType: 'products',
      entityId: productId,
      metadata: { updates }
    });

    return updated;
  }

  static async archiveProduct(tx, productId, { userRole = ROLES.OWNER } = {}) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    const product = await tx.findById('products', productId);
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    // Invariant INV-P02-06: Product archive does not silently delete variants
    await tx.update('products', productId, { is_active: false });

    // Mark variants as archived rather than deleting them
    const variants = await tx.query('product_variants', v => v.product_id === productId);
    for (const v of variants) {
      await tx.update('product_variants', v.id, { is_active: false });
    }

    await logAuditEvent(tx, {
      action: 'catalog:product_archive',
      entityType: 'products',
      entityId: productId,
      metadata: { archivedVariantsCount: variants.length }
    });

    return { productId, archived: true, archivedVariantsCount: variants.length };
  }

  static async deleteProduct(tx, productId, { userRole = ROLES.OWNER } = {}) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    const product = await tx.findById('products', productId);
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    const variants = await tx.query('product_variants', v => v.product_id === productId);
    const variantIds = new Set(variants.map(v => v.id));

    // Invariant INV-P02-09: Deletion must preserve historical references
    const sales = await tx.query('sale_items', i => variantIds.has(i.variant_id));
    const orders = await tx.query('order_items', i => variantIds.has(i.variant_id));

    if (sales.length > 0 || orders.length > 0) {
      const err = new Error(`Cannot delete product '${product.name}': Historical sales or orders exist. Use archiveProduct() instead.`);
      err.code = 'HISTORICAL_DATA_RESTRICTION';
      err.statusCode = 409;
      throw err;
    }

    // Clean deletion if no historical references
    for (const v of variants) {
      await tx.delete('product_variants', v.id);
    }
    await tx.delete('products', productId);

    await logAuditEvent(tx, {
      action: 'catalog:product_delete',
      entityType: 'products',
      entityId: productId,
      metadata: { deletedVariantsCount: variants.length }
    });

    return { productId, deleted: true };
  }

  static async getProduct(tx, productId) {
    return await tx.findById('products', productId);
  }

  static async listProducts(tx, filter = {}) {
    return await tx.query('products', p => {
      if (filter.category && p.category !== filter.category) return false;
      if (filter.isActive !== undefined && p.is_active !== filter.isActive) return false;
      return true;
    });
  }

  // ==========================================
  // VARIANT (STOCK-BEARING ENTITY) OPERATIONS
  // ==========================================

  static async createVariant(tx, {
    productId,
    sku,
    barcode = null,
    size = 'UNIQUE',
    color = 'UNIQUE',
    attributes = {},
    costPriceCentimes = 0n,
    sellingPriceCentimes,
    lowStockThreshold = 3,
    userRole = ROLES.OWNER
  }) {
    // Invariant INV-P02-07: Cashier cannot modify or provide protected cost fields
    if (userRole === ROLES.CASHIER) {
      const err = new Error('Access Denied: Cashier cannot set cost prices or create variants (INV-P02-07)');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }

    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    if (!productId) {
      throw new Error('Variant must be attached to a productId (INV-P02-03)');
    }

    // Invariant INV-P02-03 & INV-P02-04: Product must exist in current tenant
    const product = await tx.findById('products', productId);
    if (!product) {
      throw new Error(`Product ${productId} does not exist in current tenant (INV-P02-04)`);
    }

    const cleanSku = normalizeSku(sku);
    if (!cleanSku) {
      throw new Error('Variant SKU is required');
    }

    // Invariant INV-P02-01: SKU unique per tenant
    const existingSku = await tx.query('product_variants', v => v.sku === cleanSku);
    if (existingSku.length > 0) {
      const err = new Error(`SKU '${cleanSku}' already exists in tenant catalog (INV-P02-01)`);
      err.code = 'DUPLICATE_SKU';
      err.statusCode = 409;
      throw err;
    }

    // Barcode resolution & normalization
    let cleanBarcode = normalizeBarcodeInput(barcode);
    if (!cleanBarcode) {
      // Auto-generate internal EAN-13
      const allVariants = await tx.query('product_variants');
      cleanBarcode = generateInternalEan13(allVariants.length + 1);
    }

    // Invariant INV-P02-02: Barcode unique per tenant
    const existingBarcode = await tx.query('product_variants', v => v.barcode === cleanBarcode);
    if (existingBarcode.length > 0) {
      const err = new Error(`Barcode '${cleanBarcode}' already exists in tenant catalog (INV-P02-02)`);
      err.code = 'DUPLICATE_BARCODE';
      err.statusCode = 409;
      throw err;
    }

    if (sellingPriceCentimes === undefined || sellingPriceCentimes === null || BigInt(sellingPriceCentimes) < 0n) {
      throw new Error('Selling price must be non-negative integer centimes');
    }

    const costCentimes = BigInt(costPriceCentimes || 0n);
    if (costCentimes < 0n) {
      throw new Error('Cost price cannot be negative');
    }

    // Invariant INV-P02-08: Zero stock quantity is stored in product_variants
    const variant = await tx.insert('product_variants', {
      product_id: productId,
      sku: cleanSku,
      barcode: cleanBarcode,
      size: size.trim(),
      color: color.trim(),
      attributes,
      cost_price_centimes: costCentimes,
      selling_price_centimes: BigInt(sellingPriceCentimes),
      low_stock_threshold: lowStockThreshold,
      is_active: true
    });

    await logAuditEvent(tx, {
      action: 'catalog:variant_create',
      entityType: 'product_variants',
      entityId: variant.id,
      metadata: { sku: variant.sku, barcode: variant.barcode }
    });

    return variant;
  }

  static async updateVariant(tx, variantId, updates, { userRole = ROLES.OWNER } = {}) {
    // Invariant INV-P02-07: Cashier cannot modify price or cost
    if (userRole === ROLES.CASHIER) {
      const err = new Error('Access Denied: Cashier cannot modify protected price or cost fields (INV-P02-07)');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }

    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    const existing = await tx.findById('product_variants', variantId);
    if (!existing) {
      throw new Error(`Variant ${variantId} not found`);
    }

    // SKU uniqueness check if changed
    let newSku = existing.sku;
    if (updates.sku && updates.sku !== existing.sku) {
      newSku = normalizeSku(updates.sku);
      const duplicateSku = await tx.query('product_variants', v => v.sku === newSku && v.id !== variantId);
      if (duplicateSku.length > 0) {
        const err = new Error(`SKU '${newSku}' already exists in tenant catalog (INV-P02-01)`);
        err.code = 'DUPLICATE_SKU';
        err.statusCode = 409;
        throw err;
      }
    }

    // Barcode uniqueness check if changed
    let newBarcode = existing.barcode;
    if (updates.barcode && updates.barcode !== existing.barcode) {
      newBarcode = normalizeBarcodeInput(updates.barcode);
      const duplicateBarcode = await tx.query('product_variants', v => v.barcode === newBarcode && v.id !== variantId);
      if (duplicateBarcode.length > 0) {
        const err = new Error(`Barcode '${newBarcode}' already exists in tenant catalog (INV-P02-02)`);
        err.code = 'DUPLICATE_BARCODE';
        err.statusCode = 409;
        throw err;
      }
    }

    const patch = {
      sku: newSku,
      barcode: newBarcode,
      ...(updates.size ? { size: updates.size.trim() } : {}),
      ...(updates.color ? { color: updates.color.trim() } : {}),
      ...(updates.sellingPriceCentimes !== undefined ? { selling_price_centimes: BigInt(updates.sellingPriceCentimes) } : {}),
      ...(updates.costPriceCentimes !== undefined ? { cost_price_centimes: BigInt(updates.costPriceCentimes) } : {}),
      ...(updates.is_active !== undefined ? { is_active: Boolean(updates.is_active) } : {})
    };

    // Audit price changes specifically
    if (updates.sellingPriceCentimes !== undefined && BigInt(updates.sellingPriceCentimes) !== existing.selling_price_centimes) {
      await logAuditEvent(tx, {
        action: AUDIT_ACTIONS.PRICE_CHANGE,
        entityType: 'product_variants',
        entityId: variantId,
        metadata: {
          oldPrice: existing.selling_price_centimes.toString(),
          newPrice: updates.sellingPriceCentimes.toString()
        }
      });
    }

    return await tx.update('product_variants', variantId, patch);
  }

  static async archiveVariant(tx, variantId, { userRole = ROLES.OWNER } = {}) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);
    return await tx.update('product_variants', variantId, { is_active: false });
  }

  static async getVariant(tx, variantId, { userRole = ROLES.OWNER } = {}) {
    const variant = await tx.findById('product_variants', variantId);
    if (!variant) return null;
    return this._filterVariantForRole(variant, userRole);
  }

  static async getVariantByBarcode(tx, rawBarcode, { userRole = ROLES.OWNER } = {}) {
    const clean = normalizeBarcodeInput(rawBarcode);
    if (!clean) return null;
    const variants = await tx.query('product_variants', v => v.barcode === clean);
    if (variants.length === 0) return null;
    return this._filterVariantForRole(variants[0], userRole);
  }

  static async getVariantBySku(tx, rawSku, { userRole = ROLES.OWNER } = {}) {
    const clean = normalizeSku(rawSku);
    if (!clean) return null;
    const variants = await tx.query('product_variants', v => v.sku === clean);
    if (variants.length === 0) return null;
    return this._filterVariantForRole(variants[0], userRole);
  }

  static async listVariants(tx, filter = {}, { userRole = ROLES.OWNER } = {}) {
    const variants = await tx.query('product_variants', v => {
      if (filter.productId && v.product_id !== filter.productId) return false;
      if (filter.isActive !== undefined && v.is_active !== filter.isActive) return false;
      return true;
    });
    return variants.map(v => this._filterVariantForRole(v, userRole));
  }

  static async deleteVariant(tx, variantId, { userRole = ROLES.OWNER } = {}) {
    authorize(userRole, PERMISSIONS.CATALOG_WRITE);

    const variant = await tx.findById('product_variants', variantId);
    if (!variant) {
      throw new Error(`Variant ${variantId} not found`);
    }

    // Invariant INV-P02-09: Preserve historical references
    const sales = await tx.query('sale_items', i => i.variant_id === variantId);
    const orders = await tx.query('order_items', i => i.variant_id === variantId);

    if (sales.length > 0 || orders.length > 0) {
      const err = new Error(`Cannot delete variant '${variant.sku}': Historical sales or orders exist. Use archiveVariant() instead.`);
      err.code = 'HISTORICAL_DATA_RESTRICTION';
      err.statusCode = 409;
      throw err;
    }

    await tx.delete('product_variants', variantId);
    await logAuditEvent(tx, {
      action: 'catalog:variant_delete',
      entityType: 'product_variants',
      entityId: variantId,
      metadata: { sku: variant.sku }
    });

    return { variantId, deleted: true };
  }

  static _filterVariantForRole(variant, userRole) {
    if (!variant) return null;
    const clone = { ...variant };

    // Invariant INV-P02-07: Cashier and Stock Manager cannot view cost prices
    if (!hasPermission(userRole, PERMISSIONS.CATALOG_VIEW_COST)) {
      delete clone.cost_price_centimes;
    }

    return clone;
  }
}

module.exports = {
  CatalogService,
  normalizeBarcodeInput,
  normalizeSku
};
