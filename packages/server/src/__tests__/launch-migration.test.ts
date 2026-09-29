import * as productRead from '../services/products/product-read.js';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditLogs,
  initialInventory,
  inventoryBalances,
  products,
  sites,
  tenants,
  unitXProduct,
  units,
  users,
  vatRates,
} from '../db/schema.js';
import { getDatabase, type DatabaseInstance } from '../db/index.js';
import { createServer, type PuntovivoServer } from '../index.js';
import { parseImportNumber } from '../application/launch-migration/index.js';
import type { Context } from '../trpc/context.js';
import { appRouter } from '../trpc/router.js';
import { previewLaunchProductImportInput } from '../trpc/schemas/launchMigration.js';

let server: PuntovivoServer;
let db: DatabaseInstance;
let tenantId: string;
let userId: string;
let siteId: string;

function createTestContext(
  role: Context['user'] extends infer U ? NonNullable<U>['role'] : never = 'admin'
): Context {
  return {
    req: {
      server: server.app,
      headers: {},
    } as unknown as Context['req'],
    res: {} as Context['res'],
    db,
    user: {
      id: userId,
      email: 'admin@localhost',
      role,
      tenantId,
    },
    tenantId,
    siteId,
  };
}

function row(
  rowNumber: number,
  values: Partial<{
    productId: string;
    productVersion: string;
    name: string;
    sku: string;
    description: string;
    barcode: string;
    unit: string;
    price: string;
    cost: string;
    stock: string;
    minStock: string;
    taxName: string;
    taxRate: string;
    tracksStock: string;
    tracksLots: string;
  }>
) {
  return { rowNumber, values };
}

describe(' launch migration', () => {
  beforeAll(async () => {
    server = await createServer({ dbPath: ':memory:', verbose: false });
    db = getDatabase();
    const admin = await db
      .select({ id: users.id, tenantId: users.tenantId })
      .from(users)
      .where(eq(users.email, 'admin@localhost'))
      .get();
    if (!admin) throw new Error('Expected seeded admin');
    tenantId = admin.tenantId;
    userId = admin.id;
    const site = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.tenantId, tenantId))
      .get();
    if (!site) throw new Error('Expected seeded site');
    siteId = site.id;

    await appRouter.createCaller(createTestContext()).products.create({
      name: 'Existing product',
      sku: 'EXISTING-123A',
      barcode: ' 7700000123000 ',
      price: 10,
      cost: 4,
      stock: 0,
      minStock: 0,
      taxRate: 0,
      initialCost: 4,
      isActive: true,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('parses dot, comma, currency, and automatic spreadsheet number formats', () => {
    expect(parseImportNumber('1,234.56', 'dot')).toBe(1234.56);
    expect(parseImportNumber('$ 1.234,56', 'comma')).toBe(1234.56);
    expect(parseImportNumber('1,234,567.89', 'dot')).toBe(1234567.89);
    expect(parseImportNumber('1.234.567,89', 'comma')).toBe(1234567.89);
    expect(parseImportNumber('1.234,56', 'auto')).toBe(1234.56);
    expect(parseImportNumber('2.500', 'auto')).toBe(2500);
    expect(parseImportNumber('1234.567', 'auto')).toBe(1234.567);
    expect(parseImportNumber('2,5', 'auto')).toBe(2.5);
    expect(parseImportNumber('0.105', 'auto')).toBe(0.105);
    expect(parseImportNumber('0,500', 'auto')).toBe(0.5);
    expect(parseImportNumber('not-a-number', 'auto')).toBeNull();
    expect(parseImportNumber('abc12', 'auto')).toBeNull();
    expect(parseImportNumber('=1+1', 'auto')).toBeNull();
    expect(parseImportNumber('1$2', 'auto')).toBeNull();
    expect(parseImportNumber('1,2,3', 'auto')).toBeNull();
    expect(parseImportNumber('1,23.45', 'dot')).toBeNull();
    expect(parseImportNumber('1 2', 'auto')).toBeNull();
    expect(parseImportNumber('1\n2', 'auto')).toBeNull();
    expect(parseImportNumber('1 234,56', 'auto')).toBe(1234.56);
  });

  it('rejects unknown envelope fields and duplicate row numbers', () => {
    expect(
      previewLaunchProductImportInput.safeParse({
        dataMode: 'real',
        sourceName: 'strict.csv',
        rows: [{ ...row(2, { name: 'Strict', sku: 'STRICT-123A' }), unexpected: true }],
      }).success
    ).toBe(false);
    expect(
      previewLaunchProductImportInput.safeParse({
        dataMode: 'real',
        sourceName: 'strict.csv',
        rows: [row(2, { name: 'Strict', sku: 'STRICT-123A' })],
        unexpected: true,
      }).success
    ).toBe(false);
    expect(
      previewLaunchProductImportInput.safeParse({
        dataMode: 'real',
        sourceName: 'duplicates.csv',
        rows: [
          row(2, { name: 'First', sku: 'ROW-FIRST-123A' }),
          row(2, { name: 'Second', sku: 'ROW-SECOND-123A' }),
        ],
      }).success
    ).toBe(false);
  });

  it('returns row-level description length issues within the bounded transport contract', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'demo',
        sourceName: 'descriptions.csv',
        rows: [
          row(2, {
            name: 'Allowed description',
            sku: 'DESCRIPTION-OK-123A',
            description: 'a'.repeat(1_500),
          }),
          row(3, {
            name: 'Long description',
            sku: 'DESCRIPTION-LONG-123A',
            description: 'b'.repeat(2_001),
          }),
        ],
      });

    expect(preview.rows[0]?.status).toBe('ready');
    expect(preview.dataMode).toBe('demo');
    expect(preview.rows[1]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'too_long', field: 'description' }],
    });
  });

  it('previews normalized rows with tenant-scoped file and database deduplication', async () => {
    const foreignTenantId = nanoid();
    await db.insert(tenants).values({
      id: foreignTenantId,
      name: 'Foreign tenant',
      slug: `foreign-${foreignTenantId}`,
      defaultCurrencyCode: 'COP',
      isActive: true,
    });
    await db.insert(products).values({
      id: nanoid(),
      tenantId: foreignTenantId,
      name: 'Foreign-only SKU',
      sku: 'FOREIGN-SAFE-123A',
      price: 1,
      cost: 1,
      initialCost: 1,
      currencyCode: 'COP',
      minStock: 0,
      isActive: true,
      syncStatus: 'pending',
      syncVersion: 1,
    });

    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'real',
        sourceName: 'catalogo-inicial.csv',
        decimalFormat: 'comma',
        rows: [
          row(2, {
            name: 'Café premium',
            sku: 'NEW-123A',
            barcode: '7700000123999',
            price: '12.345,50',
            cost: '7.000,25',
            stock: '2,5',
            minStock: '1',
            taxRate: '19',
          }),
          row(3, { name: 'Repeated', sku: 'new-123a' }),
          row(4, { sku: 'MISSING-NAME' }),
          row(5, { name: 'Exists', sku: ' existing-123a ' }),
          row(6, { name: 'Existing barcode', sku: 'BARCODE-CLASH', barcode: '7700000123000' }),
          row(7, { name: 'Cross tenant safe', sku: 'FOREIGN-SAFE-123A' }),
        ],
      });

    expect(preview.summary).toEqual({
      total: 6,
      ready: 2,
      updates: 0,
      unchanged: 0,
      duplicates: 3,
      invalid: 1,
    });
    expect(preview.rows[0]).toMatchObject({
      rowNumber: 2,
      status: 'ready',
      normalized: { price: 12345.5, cost: 7000.25, stock: 2.5 },
    });
    expect(preview.rows[1]?.issues).toContainEqual({
      code: 'duplicate_file_sku',
      field: 'sku',
    });
    expect(preview.rows[3]?.issues).toContainEqual({
      code: 'duplicate_existing_sku',
      field: 'sku',
    });
    expect(preview.rows[4]?.issues).toContainEqual({
      code: 'duplicate_existing_barcode',
      field: 'barcode',
    });
    expect(preview.rows[5]?.status).toBe('ready');
  });

  it('validates lot-tracking booleans and rejects opening stock without lot evidence', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'real',
        sourceName: 'lot-products.csv',
        rows: [
          row(2, {
            name: 'Tracked medicine',
            sku: 'TRACKED-IMPORT-123A',
            stock: '0',
            tracksLots: 'Sí',
          }),
          row(3, {
            name: 'Unsafe tracked medicine',
            sku: 'TRACKED-STOCK-123A',
            stock: '3',
            tracksLots: 'yes',
          }),
          row(4, {
            name: 'Unknown tracking mode',
            sku: 'TRACKED-INVALID-123A',
            stock: '0',
            tracksLots: 'sometimes',
          }),
        ],
      });

    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      normalized: { tracksLots: true, stock: 0 },
    });
    expect(preview.rows[1]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'lot_tracking_requires_zero_stock', field: 'stock' }],
    });
    expect(preview.rows[2]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid_boolean', field: 'tracksLots' }],
    });
  });

  it('previews service semantics without silently converting inventory state', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'real',
        sourceName: 'services.csv',
        rows: [
          row(2, {
            name: 'Installation service',
            sku: 'SERVICE-READY-123A',
            stock: '0',
            tracksStock: 'No',
          }),
          row(3, {
            name: 'Legacy physical default',
            sku: 'PHYSICAL-DEFAULT-123A',
            stock: '0',
          }),
          row(4, {
            name: 'Stocked service',
            sku: 'SERVICE-STOCK-123A',
            stock: '2',
            tracksStock: 'false',
          }),
          row(5, {
            name: 'Lot service',
            sku: 'SERVICE-LOT-123A',
            stock: '0',
            tracksStock: '0',
            tracksLots: 'yes',
          }),
          row(6, {
            name: 'Unknown service mode',
            sku: 'SERVICE-UNKNOWN-123A',
            tracksStock: 'sometimes',
          }),
        ],
      });

    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      normalized: { tracksStock: false, tracksLots: false, stock: 0 },
    });
    expect(preview.rows[1]).toMatchObject({
      status: 'ready',
      normalized: { tracksStock: true },
    });
    expect(preview.rows[2]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'service_requires_zero_stock', field: 'stock' }],
    });
    expect(preview.rows[3]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'service_tracking_conflict', field: 'tracksLots' }],
    });
    expect(preview.rows[4]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'invalid_boolean', field: 'tracksStock' }],
    });
  });

  it('resolves tenant units and tax names while failing closed on ambiguous source values', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'real',
        sourceName: 'source-aware-products.csv',
        rows: [
          row(2, {
            name: 'Resolved catalogs',
            sku: 'PROFILE-RESOLVED-123A',
            unit: 'kg',
            taxName: 'IVA 19%',
            taxRate: '19',
          }),
          row(3, {
            name: 'Unknown unit',
            sku: 'PROFILE-UNIT-123A',
            unit: 'pallet',
          }),
          row(4, {
            name: 'Unknown tax',
            sku: 'PROFILE-TAX-123A',
            taxName: 'VAT external',
          }),
          row(5, {
            name: 'Mismatched tax',
            sku: 'PROFILE-TAX-MISMATCH-123A',
            taxName: 'IVA 19%',
            taxRate: '5',
          }),
        ],
      });

    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      normalized: { unit: 'kg', taxName: 'IVA 19%', taxRate: 19 },
    });
    expect(preview.rows[0]?.normalized.unitId).toBeTruthy();
    expect(preview.rows[0]?.normalized.vatRateId).toBeTruthy();
    expect(preview.rows[1]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'unit_not_found', field: 'unit' }],
    });
    expect(preview.rows[2]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'tax_not_found', field: 'taxName' }],
    });
    expect(preview.rows[3]).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'ambiguous_tax', field: 'taxName' }],
    });
  });

  it('fails closed when normalized unit and tax catalogs have multiple matches', async () => {
    const duplicateUnitId = nanoid();
    const duplicateVatRateId = nanoid();
    await db.insert(units).values({
      id: duplicateUnitId,
      tenantId,
      name: 'Kilogramo',
      abbreviation: 'KILO2',
      isActive: true,
    });
    await db.insert(vatRates).values({
      id: duplicateVatRateId,
      tenantId,
      name: 'iva 19%',
      rate: 19,
      isActive: true,
    });

    try {
      const preview = await appRouter
        .createCaller(createTestContext())
        .launchMigration.previewProducts({
          dataMode: 'demo',
          sourceName: 'ambiguous-catalogs.csv',
          rows: [
            row(2, {
              name: 'Ambiguous catalogs',
              sku: 'PROFILE-AMBIGUOUS-123A',
              unit: 'kg',
              taxName: 'IVA 19%',
              taxRate: '19',
            }),
          ],
        });

      expect(preview.rows[0]).toMatchObject({
        status: 'invalid',
        issues: expect.arrayContaining([
          { code: 'ambiguous_unit', field: 'unit' },
          { code: 'ambiguous_tax', field: 'taxName' },
        ]),
      });
    } finally {
      await db.delete(units).where(eq(units.id, duplicateUnitId)).run();
      await db.delete(vatRates).where(eq(vatRates.id, duplicateVatRateId)).run();
    }
  });

  it('does not resolve unit or tax catalogs from another tenant', async () => {
    const foreignTenantId = nanoid();
    const foreignUnitId = nanoid();
    const foreignVatRateId = nanoid();
    await db.insert(tenants).values({
      id: foreignTenantId,
      name: 'Foreign import catalogs',
      slug: `foreign-import-${foreignTenantId}`,
      defaultCurrencyCode: 'COP',
      isActive: true,
    });
    await db.insert(units).values({
      id: foreignUnitId,
      tenantId: foreignTenantId,
      name: 'Pallet',
      abbreviation: 'PAL',
      isActive: true,
    });
    await db.insert(vatRates).values({
      id: foreignVatRateId,
      tenantId: foreignTenantId,
      name: 'External VAT 7%',
      rate: 7,
      isActive: true,
    });

    try {
      const preview = await appRouter
        .createCaller(createTestContext())
        .launchMigration.previewProducts({
          dataMode: 'demo',
          sourceName: 'foreign-catalogs.csv',
          rows: [
            row(2, {
              name: 'Tenant-scoped catalogs',
              sku: 'PROFILE-TENANT-CATALOG-123A',
              unit: 'PAL',
              taxName: 'External VAT 7%',
              taxRate: '7',
            }),
          ],
        });

      expect(preview.rows[0]).toMatchObject({
        status: 'invalid',
        issues: expect.arrayContaining([
          { code: 'unit_not_found', field: 'unit' },
          { code: 'tax_not_found', field: 'taxName' },
        ]),
      });
    } finally {
      await db.delete(units).where(eq(units.id, foreignUnitId)).run();
      await db.delete(vatRates).where(eq(vatRates.id, foreignVatRateId)).run();
      await db.delete(tenants).where(eq(tenants.id, foreignTenantId)).run();
    }
  });

  it('flags a duplicate barcode inside the source file before confirmation', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'demo',
        sourceName: 'duplicate-barcodes.csv',
        rows: [
          row(2, {
            name: 'First barcode',
            sku: 'PROFILE-BARCODE-FIRST-123A',
            barcode: '7709999000001',
          }),
          row(3, {
            name: 'Repeated barcode',
            sku: 'PROFILE-BARCODE-SECOND-123A',
            barcode: '7709999000001',
          }),
        ],
      });

    expect(preview.rows[0]?.status).toBe('ready');
    expect(preview.rows[1]).toMatchObject({
      status: 'duplicate',
      issues: [{ code: 'duplicate_file_barcode', field: 'barcode' }],
    });
  });

  it('imports with validated units and exact stock without hydrating unused display relations', async () => {
    const sku = `LEAN-IMPORT-${nanoid()}`;
    const input = {
      dataMode: 'real' as const,
      sourceName: 'lean-import.csv',
      rows: [
        row(2, {
          name: 'Lean import',
          sku,
          unit: 'kg',
          stock: '4',
          cost: '7.81',
          price: '12.50',
          taxRate: '19',
        }),
      ],
    };
    const caller = appRouter.createCaller(createTestContext());
    const preview = await caller.launchMigration.previewProducts(input);
    expect(preview.summary.ready).toBe(1);
    const hydrate = vi.spyOn(productRead, 'getProductWithRelations');
    let productId = '';
    try {
      const result = await caller.launchMigration.importProducts({
        ...input,
        confirmedRealData: true,
        previewHash: preview.previewHash,
      });
      expect(result.summary).toMatchObject({
        imported: 1,
        stockInitialized: 1,
        failed: 0,
        warnings: 0,
      });
      productId = result.importedRows[0]!.productId;
      expect(hydrate).not.toHaveBeenCalled();
    } finally {
      hydrate.mockRestore();
    }
    const stored = await productRead.getProductWithRelations(db, productId, tenantId);
    expect(stored).toMatchObject({
      id: productId,
      sku,
      stock: 4,
      cost: 7.81,
      price: 12.5,
      taxRate: 19,
    });
    expect(stored?.unitAssignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unitAbbreviation: 'KG', isBase: true, equivalence: 1 }),
      ])
    );
    expect(
      db
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
        .get()
    ).toMatchObject({ inventoryValueCents: 3124, cogsValueCents: 3124, valuationQuantity: 4 });
    expect(
      await productRead.getProductWithRelations(db, productId, 'foreign-import-tenant')
    ).toBeNull();
  });

  it('imports a zero-stock product with lot tracking enabled', async () => {
    const input = {
      dataMode: 'real' as const,
      sourceName: 'tracked-products.csv',
      rows: [
        row(2, {
          name: 'Tracked import ready',
          sku: `TRACKED-READY-${nanoid()}`,
          stock: '0',
          tracksLots: 'true',
        }),
      ],
    };
    const caller = appRouter.createCaller(createTestContext());
    const preview = await caller.launchMigration.previewProducts(input);
    const result = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: preview.previewHash,
    });

    expect(result.summary).toMatchObject({ imported: 1, stockInitialized: 0, failed: 0 });
    const imported = await db
      .select({ tracksLots: products.tracksLots })
      .from(products)
      .where(eq(products.sku, input.rows[0]!.values.sku!))
      .get();
    expect(imported?.tracksLots).toBe(true);
  });

  it('imports a service without creating inventory balances', async () => {
    const sku = `SERVICE-IMPORT-${nanoid()}`;
    const input = {
      dataMode: 'real' as const,
      sourceName: 'service-products.csv',
      rows: [
        row(2, {
          name: 'Delivery and setup',
          sku,
          price: '45',
          stock: '0',
          tracksStock: 'No',
        }),
      ],
    };
    const caller = appRouter.createCaller(createTestContext());
    const preview = await caller.launchMigration.previewProducts(input);
    const result = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: preview.previewHash,
    });

    expect(result.summary).toMatchObject({ imported: 1, stockInitialized: 0, failed: 0 });
    const imported = await db
      .select({ id: products.id, tracksStock: products.tracksStock })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.sku, sku)))
      .get();
    expect(imported?.tracksStock).toBe(false);
    expect(
      await db
        .select()
        .from(inventoryBalances)
        .where(eq(inventoryBalances.productId, imported!.id))
        .all()
    ).toHaveLength(0);
  });

  it('imports products, prices, and opening stock with audit evidence and retry-safe skips', async () => {
    const input = {
      dataMode: 'real' as const,
      sourceName: 'launch-products.xlsx',
      decimalFormat: 'dot' as const,
      rows: [
        row(2, {
          name: 'Imported cacao',
          sku: 'IMPORT-123A-CACAO',
          description: 'Launch catalog',
          barcode: '7700000123111',
          unit: 'KG',
          price: '15.50',
          cost: '8.25',
          stock: '12.5',
          minStock: '3',
          taxName: 'IVA 19%',
          taxRate: '19',
        }),
        row(3, { name: '', sku: 'INVALID-123A' }),
        row(4, {
          name: 'Imported zero stock',
          sku: 'IMPORT-123A-ZERO',
          price: '5',
          cost: '2',
          stock: '0',
        }),
      ],
    };
    const caller = appRouter.createCaller(createTestContext());
    const preview = await caller.launchMigration.previewProducts(input);
    const result = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: preview.previewHash,
    });

    expect(result.summary).toEqual({
      total: 3,
      imported: 2,
      updated: 0,
      unchanged: 0,
      stockInitialized: 1,
      skipped: 0,
      invalid: 1,
      failed: 0,
      warnings: 0,
    });
    const product = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.sku, 'IMPORT-123A-CACAO')))
      .get();
    expect(product).toMatchObject({
      name: 'Imported cacao',
      price: 15.5,
      cost: 8.25,
      initialCost: 8.25,
      minStock: 3,
      taxRate: 19,
      vatRateId: expect.any(String),
    });
    const importedUnit = await db
      .select({ abbreviation: units.abbreviation })
      .from(unitXProduct)
      .innerJoin(units, eq(unitXProduct.unitId, units.id))
      .where(eq(unitXProduct.productId, product!.id))
      .get();
    expect(importedUnit?.abbreviation).toBe('KG');
    const balance = await db
      .select()
      .from(inventoryBalances)
      .where(
        and(
          eq(inventoryBalances.tenantId, tenantId),
          eq(inventoryBalances.siteId, siteId),
          eq(inventoryBalances.productId, product!.id)
        )
      )
      .get();
    expect(balance?.onHand).toBe(12.5);
    const opening = await db
      .select()
      .from(initialInventory)
      .where(
        and(eq(initialInventory.tenantId, tenantId), eq(initialInventory.productId, product!.id))
      )
      .get();
    expect(opening).toMatchObject({ mode: 'initial', quantity: 12.5, cost: 8.25 });

    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.resourceId, result.importId),
          eq(auditLogs.action, 'data_import.products')
        )
      )
      .get();
    expect(audit?.actorId).toBe(userId);
    expect(audit?.resourceType).toBe('data_import');
    expect(JSON.stringify(audit)).not.toContain('Imported cacao');
    expect(JSON.stringify(audit)).not.toContain('launch-products.xlsx');
    expect(audit?.metadata).toMatchObject({ dataMode: 'real', sourceFormat: 'xlsx' });

    const retryPreview = await caller.launchMigration.previewProducts(input);
    const retry = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: retryPreview.previewHash,
    });
    expect(retry.summary).toMatchObject({ imported: 0, skipped: 2, invalid: 1 });
    expect(retry.skippedRows).toEqual(
      expect.arrayContaining([
        {
          rowNumber: 2,
          issues: expect.arrayContaining([
            { code: 'duplicate_existing_sku', field: 'sku' },
            { code: 'duplicate_existing_barcode', field: 'barcode' },
          ]),
        },
        {
          rowNumber: 4,
          issues: [{ code: 'duplicate_existing_sku', field: 'sku' }],
        },
      ])
    );
  });

  it('reads fractional supplier VAT rates as percentages', async () => {
    const preview = await appRouter
      .createCaller(createTestContext())
      .launchMigration.previewProducts({
        dataMode: 'demo',
        sourceName: 'lista-proveedor.xlsx',
        decimalFormat: 'auto',
        rows: [
          row(2, { name: 'Abrazadera', sku: 'VAT-FRACTION-1', cost: '8404.7355', taxRate: '0.21' }),
          row(3, { name: 'Disco flap', sku: 'VAT-FRACTION-2', cost: '1979.11', taxRate: '0.105' }),
          row(4, { name: 'Piolin', sku: 'VAT-FRACTION-3', cost: '1357.14', taxRate: '21' }),
        ],
      });

    expect(preview.rows.map(item => item.normalized.taxRate)).toEqual([21, 10.5, 21]);
    expect(preview.rows[0]?.normalized.cost).toBe(8404.74);
    expect(preview.summary.ready).toBe(3);
  });

  it('updates existing products from a supplier list without touching unmapped fields', async () => {
    const caller = appRouter.createCaller(createTestContext());
    const existing = await caller.products.create({
      name: 'Supplier product',
      sku: 'SUP-24100',
      barcode: '7700000555001',
      price: 5000,
      cost: 3000,
      stock: 0,
      minStock: 0,
      taxRate: 21,
      initialCost: 3000,
      isActive: true,
    });
    await caller.products.create({
      name: 'Supplier unchanged',
      sku: 'SUP-24101',
      price: 900,
      cost: 500,
      stock: 0,
      minStock: 0,
      taxRate: 21,
      initialCost: 500,
      isActive: true,
    });

    const input = {
      dataMode: 'real' as const,
      sourceName: 'DILMAS.xls',
      decimalFormat: 'auto' as const,
      importMode: 'upsert' as const,
      rows: [
        row(96, {
          name: 'Renamed by supplier',
          sku: 'sup-24100',
          barcode: '7700000555001',
          cost: '3500.456',
          taxRate: '0.105',
        }),
        row(97, { name: 'Supplier unchanged', sku: 'SUP-24101', cost: '500', taxRate: '21' }),
        row(98, {
          name: 'Brand new supplier item',
          sku: 'SUP-24102',
          cost: '120',
          taxRate: '0.21',
        }),
        row(99, {
          name: 'Barcode clash',
          sku: 'SUP-24103',
          barcode: '7700000555001',
          cost: '10',
        }),
      ],
    };

    const createOnly = await caller.launchMigration.previewProducts({
      ...input,
      dataMode: 'demo',
      importMode: 'create',
    });
    expect(createOnly.rows[0]?.status).toBe('duplicate');

    const preview = await caller.launchMigration.previewProducts(input);
    expect(preview.summary).toMatchObject({
      total: 4,
      ready: 1,
      updates: 1,
      unchanged: 1,
      duplicates: 1,
      invalid: 0,
    });
    expect(preview.rows[0]).toMatchObject({
      status: 'update',
      existing: { productId: existing.id, cost: 3000, price: 5000, taxRate: 21 },
      changes: { cost: 3500.46, taxRate: 10.5, vatRateId: null },
    });
    expect(preview.rows[0]?.changes).not.toHaveProperty('price');
    expect(preview.rows[1]?.status).toBe('unchanged');
    expect(preview.rows[3]).toMatchObject({
      status: 'duplicate',
      issues: [{ code: 'duplicate_file_barcode', field: 'barcode' }],
    });

    const result = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: preview.previewHash,
    });
    expect(result.summary).toMatchObject({
      imported: 1,
      updated: 1,
      unchanged: 1,
      skipped: 1,
      failed: 0,
    });
    expect(result.updatedRows).toEqual([{ rowNumber: 96, productId: existing.id }]);

    const updated = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, existing.id)))
      .get();
    expect(updated).toMatchObject({
      name: 'Supplier product',
      cost: 3500.46,
      price: 5000,
      taxRate: 10.5,
    });
    const created = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.sku, 'SUP-24102')))
      .get();
    expect(created).toMatchObject({ cost: 120, price: 0, taxRate: 21 });

    // The commit re-reads the catalog, so an edit made after the operator's
    // preview is compared against its latest version instead of clobbered
    // through a stale version token.
    const rerunInput = { ...input, rows: [input.rows[0]!] };
    const rerunPreview = await caller.launchMigration.previewProducts(rerunInput);
    expect(rerunPreview.rows[0]?.status).toBe('unchanged');
    await caller.products.update({
      id: existing.id,
      version: rerunPreview.rows[0]!.existing!.version,
      cost: 1,
    });
    const rerun = await caller.launchMigration.importProducts({
      ...rerunInput,
      confirmedRealData: true,
      previewHash: rerunPreview.previewHash,
    });
    expect(rerun.summary).toMatchObject({ updated: 1, unchanged: 0, failed: 0 });
    const reapplied = await db
      .select({ cost: products.cost })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, existing.id)))
      .get();
    expect(reapplied?.cost).toBe(3500.46);
  });

  it('updates catalog identity and pricing by tenant-owned ID without falling back to SKU', async () => {
    const caller = appRouter.createCaller(createTestContext());
    const original = await caller.products.create({
      name: 'Original item',
      sku: 'ID-ORIGINAL-1',
      description: 'Old description',
      price: 100,
      cost: 60,
      taxRate: 19,
      stock: 0,
    });
    const other = await caller.products.create({
      name: 'Other item',
      sku: 'ID-OTHER-1',
      price: 20,
      stock: 0,
    });
    const input = {
      dataMode: 'real' as const,
      sourceName: 'products-editable.xlsx',
      importMode: 'upsert' as const,
      decimalFormat: 'auto' as const,
      rows: [
        row(2, {
          productId: original.id,
          productVersion: String(original.version),
          name: 'Renamed item',
          sku: 'ID-RENAMED-1',
          description: '',
          cost: '70',
          price: '130',
          taxRate: '21',
        }),
        row(3, { productId: 'missing-id', name: 'No fallback', sku: other.sku, cost: '88' }),
        row(4, { productId: original.id, name: 'Repeated ID', sku: 'ID-NEW-4', cost: '80' }),
        row(5, { productId: other.id, name: 'Collision', sku: original.sku, cost: '30' }),
      ],
    };
    const preview = await caller.launchMigration.previewProducts(input);
    expect(preview.rows[0]).toMatchObject({
      status: 'update',
      existing: {
        productId: original.id,
        name: 'Original item',
        sku: original.sku,
        description: 'Old description',
      },
      changes: {
        name: 'Renamed item',
        sku: 'ID-RENAMED-1',
        description: null,
        cost: 70,
        price: 130,
        taxRate: 21,
      },
    });
    expect(preview.rows[1]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'product_id_not_found', field: 'productId' }]),
    });
    expect(preview.rows[2]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'duplicate_file_product_id', field: 'productId' }]),
    });
    expect(preview.rows[3]).toMatchObject({
      status: 'duplicate',
      issues: expect.arrayContaining([{ code: 'duplicate_existing_sku', field: 'sku' }]),
    });
    const otherContext = createTestContext();
    otherContext.tenantId = 'another-tenant';
    otherContext.user!.tenantId = 'another-tenant';
    const foreign = await appRouter.createCaller(otherContext).launchMigration.previewProducts({
      ...input,
      rows: [input.rows[0]!],
    });
    expect(foreign.rows[0]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'product_id_not_found', field: 'productId' }]),
    });
    const createOnly = await caller.launchMigration.previewProducts({
      ...input,
      importMode: 'create',
      rows: [input.rows[0]!],
    });
    expect(createOnly.rows[0]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'product_id_requires_update', field: 'productId' }]),
    });
    const result = await caller.launchMigration.importProducts({
      ...input,
      confirmedRealData: true,
      previewHash: preview.previewHash,
    });
    expect(result.summary).toMatchObject({ updated: 1, imported: 0 });
    expect(await caller.products.getById({ id: original.id })).toMatchObject({
      name: 'Renamed item',
      sku: 'ID-RENAMED-1',
      description: null,
      cost: 70,
      price: 130,
      taxRate: 21,
    });
    expect(await caller.products.getById({ id: other.id })).toMatchObject({
      name: 'Other item',
      sku: 'ID-OTHER-1',
    });
    const partial = await caller.launchMigration.previewProducts({
      ...input,
      rows: [row(2, { productId: other.id, description: 'Only description changes' })],
    });
    expect(partial.rows[0]).toMatchObject({
      status: 'update',
      normalized: {
        name: 'Other item',
        sku: 'ID-OTHER-1',
        cost: other.cost,
        price: other.price,
        taxRate: other.taxRate,
      },
      changes: { description: 'Only description changes' },
    });
    expect(partial.rows[0]?.changes).not.toHaveProperty('cost');
    const invalidVersion = await caller.launchMigration.previewProducts({
      ...input,
      rows: [
        row(2, { productId: other.id, productVersion: 'not-a-version', name: 'Do not update' }),
      ],
    });
    expect(invalidVersion.rows[0]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([
        { code: 'invalid_product_version', field: 'productVersion' },
      ]),
    });
    const emptyName = await caller.launchMigration.previewProducts({
      ...input,
      rows: [row(2, { productId: other.id, name: '', sku: other.sku })],
    });
    expect(emptyName.rows[0]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'required', field: 'name' }]),
    });
    const stale = await caller.launchMigration.previewProducts({
      ...input,
      rows: [input.rows[0]!],
    });
    expect(stale.rows[0]).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([{ code: 'concurrent_update', field: 'productVersion' }]),
    });
  });

  it('rejects a catalog edit when the product changes after preview', async () => {
    const caller = appRouter.createCaller(createTestContext());
    const product = await caller.products.create({
      name: 'Concurrent item',
      sku: 'ID-CONCURRENT-1',
      price: 10,
      stock: 0,
    });
    const input = {
      dataMode: 'real' as const,
      sourceName: 'products-editable.xlsx',
      importMode: 'upsert' as const,
      rows: [
        row(2, {
          productId: product.id,
          productVersion: String(product.version),
          name: 'Updated from file',
          sku: product.sku,
        }),
      ],
    };
    const preview = await caller.launchMigration.previewProducts(input);
    await caller.products.update({
      id: product.id,
      version: product.version,
      name: 'Other operator',
    });
    await expect(
      caller.launchMigration.importProducts({
        ...input,
        confirmedRealData: true,
        previewHash: preview.previewHash,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await caller.products.getById({ id: product.id })).toMatchObject({
      name: 'Other operator',
    });
  });

  it('rejects stale preview hashes and non-admin callers', async () => {
    const input = {
      dataMode: 'real' as const,
      sourceName: 'guard.csv',
      decimalFormat: 'auto' as const,
      rows: [row(2, { name: 'Guarded', sku: 'GUARD-123A' })],
    };
    const admin = appRouter.createCaller(createTestContext());
    await expect(
      admin.launchMigration.importProducts({
        ...input,
        confirmedRealData: true,
        previewHash: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const manager = appRouter.createCaller(createTestContext('manager'));
    await expect(manager.launchMigration.previewProducts(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
