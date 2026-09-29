/**
 * Server-authoritative product, price, and opening-stock import.
 *
 * The browser only maps source columns. Every value is reparsed, validated,
 * deduplicated, and tenant-scoped here before any catalog write runs.
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { createProductForImport, updateProduct } from '../products/index.js';
import { recordInventoryEntry } from '../inventory/index.js';
import { products, units, vatRates } from '../../db/schema.js';
import { createModuleLogger } from '../../logging/logger.js';
import { roundMoney } from '../../lib/money.js';
import { writeAuditLog } from '../../services/audit-logs.js';
import type {
  CommitLaunchProductImportInput,
  ImportDecimalFormat,
  LaunchProductImportRow,
  PreviewLaunchProductImportInput,
} from '../../trpc/schemas/launchMigration.js';
import type {
  LaunchMigrationContext,
  NormalizedLaunchProduct,
  ProductImportChanges,
  ProductImportExistingProduct,
  ProductImportIssue,
  ProductImportPreviewRow,
} from './types.js';
import {
  assertRealDataCommit,
  getImportSourceFormat,
  getSafeImportErrorMetadata,
} from './safety.js';
import { parseImportNumber } from './numbers.js';

const log = createModuleLogger('launch-migration');

const DUPLICATE_ISSUES = new Set<ProductImportIssue['code']>([
  'duplicate_file_sku',
  'duplicate_existing_sku',
  'duplicate_file_barcode',
  'duplicate_existing_barcode',
]);

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function normalizeBarcode(value: string): string {
  return value.trim();
}

function normalizeCatalogKey(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  each: 'und',
  piece: 'und',
  pieza: 'und',
  unit: 'und',
  unidad: 'und',
  unidades: 'und',
  un: 'und',
  kilogram: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  kgs: 'kg',
  pound: 'lb',
  pounds: 'lb',
  libra: 'lb',
  libras: 'lb',
  box: 'cj',
  caja: 'cj',
  cajas: 'cj',
  dozen: 'doc',
  docena: 'doc',
};

const NO_TAX_NAMES = new Set(['none', 'ninguno', 'no tax', 'sin impuesto']);

interface ProductImportCatalogs {
  units: Array<{
    id: string;
    name: string;
    abbreviation: string;
    standardCode: string | null;
  }>;
  vatRates: Array<{ id: string; name: string; rate: number }>;
}

function canonicalUnitKey(value: string): string {
  const key = normalizeCatalogKey(value);
  return UNIT_ALIASES[key] ?? key;
}

function resolveImportUnit(
  raw: string | undefined,
  catalogs: ProductImportCatalogs
): { unit: string | null; unitId: string | null; issue?: ProductImportIssue } {
  const unit = raw?.trim() || null;
  if (!unit) return { unit: null, unitId: null };
  const sourceKey = canonicalUnitKey(unit);
  const matches = catalogs.units.filter(candidate =>
    [candidate.name, candidate.abbreviation, candidate.standardCode]
      .filter((value): value is string => Boolean(value))
      .some(value => canonicalUnitKey(value) === sourceKey)
  );
  if (matches.length === 0) {
    return { unit, unitId: null, issue: { code: 'unit_not_found', field: 'unit' } };
  }
  if (matches.length > 1) {
    return { unit, unitId: null, issue: { code: 'ambiguous_unit', field: 'unit' } };
  }
  return { unit, unitId: matches[0]!.id };
}

function resolveImportTax(
  rawName: string | undefined,
  rawRate: string | undefined,
  parsedRate: number | null,
  catalogs: ProductImportCatalogs
): {
  taxName: string | null;
  taxRate: number;
  vatRateId: string | null;
  issue?: ProductImportIssue;
} {
  const taxName = rawName?.trim() || null;
  const hasExplicitRate = Boolean(rawRate?.trim());
  if (!taxName) {
    return { taxName: null, taxRate: parsedRate ?? 0, vatRateId: null };
  }
  const taxKey = normalizeCatalogKey(taxName);
  if (NO_TAX_NAMES.has(taxKey)) {
    if (hasExplicitRate && (parsedRate ?? 0) !== 0) {
      return {
        taxName,
        taxRate: parsedRate ?? 0,
        vatRateId: null,
        issue: { code: 'ambiguous_tax', field: 'taxName' },
      };
    }
    return { taxName, taxRate: 0, vatRateId: null };
  }
  const matches = catalogs.vatRates.filter(
    candidate => normalizeCatalogKey(candidate.name) === taxKey
  );
  if (matches.length === 0) {
    return {
      taxName,
      taxRate: parsedRate ?? 0,
      vatRateId: null,
      issue: { code: 'tax_not_found', field: 'taxName' },
    };
  }
  if (matches.length > 1) {
    return {
      taxName,
      taxRate: parsedRate ?? 0,
      vatRateId: null,
      issue: { code: 'ambiguous_tax', field: 'taxName' },
    };
  }
  const match = matches[0]!;
  if (hasExplicitRate && parsedRate !== null && Math.abs(match.rate - parsedRate) > 1e-9) {
    return {
      taxName,
      taxRate: parsedRate,
      vatRateId: null,
      issue: { code: 'ambiguous_tax', field: 'taxName' },
    };
  }
  return { taxName, taxRate: match.rate, vatRateId: match.id };
}

function parseImportBoolean(value: string | undefined, defaultValue = false): boolean | null {
  const normalized = (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US');
  if (!normalized) return defaultValue;
  if (['true', 'yes', 'y', 'si', 's', '1'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return null;
}

function canonicalImportPayload(input: PreviewLaunchProductImportInput) {
  return {
    dataMode: input.dataMode,
    sourceName: input.sourceName,
    decimalFormat: input.decimalFormat,
    importMode: input.importMode,
    rows: input.rows.map(row => ({ rowNumber: row.rowNumber, values: row.values })),
  };
}

export function hashLaunchProductImport(input: PreviewLaunchProductImportInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalImportPayload(input)))
    .digest('hex');
}

function normalizeRow(
  row: LaunchProductImportRow,
  decimalFormat: ImportDecimalFormat,
  catalogs: ProductImportCatalogs
): { normalized: NormalizedLaunchProduct; issues: ProductImportIssue[] } {
  const name = row.values.name?.trim() ?? '';
  const sku = row.values.sku?.trim() ?? '';
  const description = row.values.description?.trim() || null;
  const barcode = row.values.barcode?.trim() || null;
  const issues: ProductImportIssue[] = [];
  const tracksStock = parseImportBoolean(row.values.tracksStock, true);
  const tracksLots = parseImportBoolean(row.values.tracksLots);
  const resolvedUnit = resolveImportUnit(row.values.unit, catalogs);

  if (!name && (row.values.productId === undefined || row.values.name !== undefined)) {
    issues.push({ code: 'required', field: 'name' });
  }
  if (!sku && (row.values.productId === undefined || row.values.sku !== undefined)) {
    issues.push({ code: 'required', field: 'sku' });
  }
  if (name.length > 255) issues.push({ code: 'too_long', field: 'name' });
  if (sku.length > 100) issues.push({ code: 'too_long', field: 'sku' });
  if (description && description.length > 2_000) {
    issues.push({ code: 'too_long', field: 'description' });
  }
  if (barcode && barcode.length > 64) issues.push({ code: 'too_long', field: 'barcode' });

  const numericFields = ['price', 'cost', 'stock', 'minStock', 'taxRate'] as const;
  const values = Object.fromEntries(
    numericFields.map(field => [field, parseImportNumber(row.values[field], decimalFormat)])
  ) as Record<(typeof numericFields)[number], number | null>;

  // Supplier lists often store VAT as a fraction (0.21, 0.105). A positive
  // rate below 1% is not a real VAT rate, so read it as a fraction.
  if (values.taxRate !== null && values.taxRate > 0 && values.taxRate < 1) {
    values.taxRate = Math.round(values.taxRate * 100 * 10_000) / 10_000;
  }

  for (const field of numericFields) {
    const value = values[field];
    if (value === null) {
      issues.push({ code: 'invalid_number', field });
    } else if (value < 0 || (field === 'taxRate' && value > 100)) {
      issues.push({ code: 'out_of_range', field });
    }
  }
  const resolvedTax = resolveImportTax(
    row.values.taxName,
    row.values.taxRate,
    values.taxRate,
    catalogs
  );
  if (resolvedUnit.issue) issues.push(resolvedUnit.issue);
  if (resolvedTax.issue) issues.push(resolvedTax.issue);
  if (tracksLots === null) {
    issues.push({ code: 'invalid_boolean', field: 'tracksLots' });
  }
  if (tracksStock === null) {
    issues.push({ code: 'invalid_boolean', field: 'tracksStock' });
  }
  if (tracksStock === false && (values.stock ?? 0) > 0) {
    issues.push({ code: 'service_requires_zero_stock', field: 'stock' });
  }
  if (tracksStock === false && tracksLots === true) {
    issues.push({ code: 'service_tracking_conflict', field: 'tracksLots' });
  }
  if (tracksLots === true && (values.stock ?? 0) > 0) {
    issues.push({ code: 'lot_tracking_requires_zero_stock', field: 'stock' });
  }

  return {
    normalized: {
      name,
      sku,
      description,
      barcode,
      unit: resolvedUnit.unit,
      unitId: resolvedUnit.unitId,
      price: roundMoney(values.price ?? 0),
      cost: roundMoney(values.cost ?? 0),
      stock: values.stock ?? 0,
      minStock: values.minStock ?? 0,
      taxName: resolvedTax.taxName,
      taxRate: resolvedTax.taxRate,
      vatRateId: resolvedTax.vatRateId,
      tracksStock: tracksStock ?? true,
      tracksLots: tracksLots ?? false,
    },
    issues,
  };
}

async function loadImportCatalogs(ctx: LaunchMigrationContext): Promise<ProductImportCatalogs> {
  const [availableUnits, availableVatRates] = await Promise.all([
    ctx.db
      .select({
        id: units.id,
        name: units.name,
        abbreviation: units.abbreviation,
        standardCode: units.standardCode,
      })
      .from(units)
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.isActive, true)))
      .all(),
    ctx.db
      .select({ id: vatRates.id, name: vatRates.name, rate: vatRates.rate })
      .from(vatRates)
      .where(and(eq(vatRates.tenantId, ctx.tenantId), eq(vatRates.isActive, true)))
      .all(),
  ]);
  return { units: availableUnits, vatRates: availableVatRates };
}

interface ExistingCatalogProduct extends ProductImportExistingProduct {
  vatRateId: string | null;
}

async function loadExistingProducts(
  ctx: LaunchMigrationContext,
  normalizedRows: Array<{ row: LaunchProductImportRow; normalized: NormalizedLaunchProduct }>
) {
  const skuKeys = [
    ...new Set(
      normalizedRows.map(({ normalized }) => normalizeKey(normalized.sku)).filter(Boolean)
    ),
  ];
  const ids = [
    ...new Set(
      normalizedRows
        .map(({ row }) => row.values.productId?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const barcodeKeys = [
    ...new Set(
      normalizedRows
        .map(({ normalized }) => (normalized.barcode ? normalizeBarcode(normalized.barcode) : null))
        .filter((value): value is string => Boolean(value))
    ),
  ];

  const existingSkuRows =
    skuKeys.length > 0
      ? await ctx.db
          .select({
            productId: products.id,
            version: products.version,
            sku: products.sku,
            name: products.name,
            description: products.description,
            cost: products.cost,
            price: products.price,
            taxRate: products.taxRate,
            vatRateId: products.vatRateId,
          })
          .from(products)
          .where(
            and(
              eq(products.tenantId, ctx.tenantId),
              inArray(sql<string>`lower(trim(${products.sku}))`, skuKeys)
            )
          )
          .all()
      : [];
  const existingIdRows = ids.length
    ? await ctx.db
        .select({
          productId: products.id,
          version: products.version,
          sku: products.sku,
          name: products.name,
          description: products.description,
          cost: products.cost,
          price: products.price,
          taxRate: products.taxRate,
          vatRateId: products.vatRateId,
        })
        .from(products)
        .where(and(eq(products.tenantId, ctx.tenantId), inArray(products.id, ids)))
        .all()
    : [];
  const existingBarcodeRows =
    barcodeKeys.length > 0
      ? await ctx.db
          .select({ id: products.id, barcode: products.barcode })
          .from(products)
          .where(
            and(
              eq(products.tenantId, ctx.tenantId),
              inArray(sql<string>`trim(${products.barcode})`, barcodeKeys)
            )
          )
          .all()
      : [];

  // A case-insensitive key can match several stored SKUs; such a key is
  // ambiguous and never selects an update target.
  const skus = new Map<string, ExistingCatalogProduct[]>();
  for (const { sku, ...product } of existingSkuRows) {
    const key = normalizeKey(sku);
    skus.set(key, [...(skus.get(key) ?? []), { ...product, sku }]);
  }
  const byId = new Map(existingIdRows.map(product => [product.productId, product]));
  const barcodes = new Map<string, Set<string>>();
  for (const row of existingBarcodeRows) {
    if (!row.barcode) continue;
    const key = normalizeBarcode(row.barcode);
    barcodes.set(key, (barcodes.get(key) ?? new Set()).add(row.id));
  }
  return { skus, byId, barcodes };
}

function hasRawValue(row: LaunchProductImportRow, field: keyof LaunchProductImportRow['values']) {
  return Boolean(row.values[field]?.trim());
}

/**
 * Fields a supplier-list row changes on an existing product. Only columns
 * the file actually fills are compared, so an unmapped or empty sale price
 * never overwrites the stored one.
 */
function diffExistingProduct(
  row: LaunchProductImportRow,
  normalized: NormalizedLaunchProduct,
  existing: ExistingCatalogProduct
): ProductImportChanges {
  const changes: ProductImportChanges = {};
  // Supplier lists do not own catalog identity. Only an explicit ID row may
  // change name, description or SKU (including clearing description).
  if (row.values.productId !== undefined) {
    if (row.values.name !== undefined && normalized.name !== existing.name)
      changes.name = normalized.name;
    if (row.values.sku !== undefined && normalized.sku !== existing.sku)
      changes.sku = normalized.sku;
    if (row.values.description !== undefined && normalized.description !== existing.description) {
      changes.description = normalized.description;
    }
  }
  if (hasRawValue(row, 'cost') && normalized.cost !== existing.cost) {
    changes.cost = normalized.cost;
  }
  if (hasRawValue(row, 'price') && normalized.price !== existing.price) {
    changes.price = normalized.price;
  }
  const taxProvided = hasRawValue(row, 'taxRate') || hasRawValue(row, 'taxName');
  const vatRateChanged =
    normalized.vatRateId !== null && normalized.vatRateId !== existing.vatRateId;
  if (taxProvided && (Math.abs(normalized.taxRate - existing.taxRate) > 1e-9 || vatRateChanged)) {
    changes.taxRate = normalized.taxRate;
    changes.vatRateId = normalized.vatRateId;
  }
  return changes;
}

export async function previewLaunchProductImport(
  ctx: LaunchMigrationContext,
  input: PreviewLaunchProductImportInput
) {
  const catalogs = await loadImportCatalogs(ctx);
  const normalizedRows = input.rows.map(row => ({
    row,
    ...normalizeRow(row, input.decimalFormat, catalogs),
  }));
  const existing = await loadExistingProducts(ctx, normalizedRows);
  const upsert = input.importMode === 'upsert';
  const seenSkus = new Set<string>();
  const seenIds = new Set<string>();
  const seenBarcodes = new Set<string>();

  const rows: ProductImportPreviewRow[] = normalizedRows.map(({ row, normalized, ...rest }) => {
    const issues = [...rest.issues];
    const skuKey = normalizeKey(normalized.sku);
    const hasId = row.values.productId !== undefined;
    const productId = row.values.productId?.trim() ?? '';
    const barcodeKey = normalized.barcode ? normalizeBarcode(normalized.barcode) : null;
    let target: ExistingCatalogProduct | undefined;

    if (hasId) {
      if (!upsert) {
        issues.push({ code: 'product_id_requires_update', field: 'productId' });
      } else if (!productId || !existing.byId.has(productId)) {
        issues.push({ code: 'product_id_not_found', field: 'productId' });
      } else if (seenIds.has(productId)) {
        issues.push({ code: 'duplicate_file_product_id', field: 'productId' });
      } else {
        target = existing.byId.get(productId);
      }
      if (productId) seenIds.add(productId);
      if (row.values.productVersion !== undefined) {
        const rawVersion = row.values.productVersion.trim();
        const expectedVersion = Number(rawVersion);
        if (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(expectedVersion)) {
          issues.push({ code: 'invalid_product_version', field: 'productVersion' });
        } else if (target && target.version !== expectedVersion) {
          issues.push({ code: 'concurrent_update', field: 'productVersion' });
        }
      }
    }

    if (skuKey) {
      const matches = existing.skus.get(skuKey) ?? [];
      if (seenSkus.has(skuKey)) {
        issues.push({ code: 'duplicate_file_sku', field: 'sku' });
      } else if (matches.length > 0) {
        if (hasId) {
          if (matches.some(match => match.productId !== productId)) {
            issues.push({ code: 'duplicate_existing_sku', field: 'sku' });
          }
        } else if (upsert && matches.length === 1) target = matches[0];
        else issues.push({ code: 'duplicate_existing_sku', field: 'sku' });
      }
      seenSkus.add(skuKey);
    }
    if (barcodeKey) {
      const owners = existing.barcodes.get(barcodeKey);
      if (seenBarcodes.has(barcodeKey)) {
        issues.push({ code: 'duplicate_file_barcode', field: 'barcode' });
      } else if (owners && !(target && owners.size === 1 && owners.has(target.productId))) {
        issues.push({ code: 'duplicate_existing_barcode', field: 'barcode' });
      }
      seenBarcodes.add(barcodeKey);
    }

    const hasValidationIssue = issues.some(issue => !DUPLICATE_ISSUES.has(issue.code));
    if (hasValidationIssue || issues.length > 0 || !target) {
      const status = hasValidationIssue ? 'invalid' : issues.length > 0 ? 'duplicate' : 'ready';
      return { rowNumber: row.rowNumber, status, normalized, issues };
    }
    const effective = hasId
      ? {
          ...normalized,
          name: row.values.name === undefined ? target.name : normalized.name,
          sku: row.values.sku === undefined ? target.sku : normalized.sku,
          description:
            row.values.description === undefined ? target.description : normalized.description,
          cost: hasRawValue(row, 'cost') ? normalized.cost : target.cost,
          price: hasRawValue(row, 'price') ? normalized.price : target.price,
          taxRate:
            hasRawValue(row, 'taxRate') || hasRawValue(row, 'taxName')
              ? normalized.taxRate
              : target.taxRate,
        }
      : normalized;
    const changes = diffExistingProduct(row, effective, target);
    return {
      rowNumber: row.rowNumber,
      status: Object.keys(changes).length > 0 ? 'update' : 'unchanged',
      normalized: effective,
      issues,
      existing: {
        productId: target.productId,
        version: target.version,
        name: target.name,
        sku: target.sku,
        description: target.description,
        cost: target.cost,
        price: target.price,
        taxRate: target.taxRate,
      },
      changes,
    };
  });

  return {
    dataMode: input.dataMode,
    importMode: input.importMode,
    // ID-based edits must be reviewed against the exact catalog revisions seen
    // in preview. Supplier-list imports retain their historical rebase behavior.
    previewHash: input.rows.some(row => row.values.productId !== undefined)
      ? createHash('sha256')
          .update(hashLaunchProductImport(input))
          .update(JSON.stringify(rows.map(row => row.existing?.version ?? null)))
          .digest('hex')
      : hashLaunchProductImport(input),
    summary: {
      total: rows.length,
      ready: rows.filter(row => row.status === 'ready').length,
      updates: rows.filter(row => row.status === 'update').length,
      unchanged: rows.filter(row => row.status === 'unchanged').length,
      duplicates: rows.filter(row => row.status === 'duplicate').length,
      invalid: rows.filter(row => row.status === 'invalid').length,
    },
    rows,
  };
}

function isConflictError(error: unknown): boolean {
  return (
    (error instanceof TRPCError && error.code === 'CONFLICT') ||
    (error instanceof Error && /UNIQUE constraint failed.*products/i.test(error.message))
  );
}

export async function commitLaunchProductImport(
  ctx: LaunchMigrationContext,
  input: CommitLaunchProductImportInput
) {
  assertRealDataCommit(input);
  const preview = await previewLaunchProductImport(ctx, input);
  if (preview.previewHash !== input.previewHash) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The import changed after preview. Preview it again before importing.',
    });
  }

  const importId = nanoid();
  const importedRows: Array<{
    rowNumber: number;
    productId: string;
    stockInitialized: boolean;
    issues: ProductImportIssue[];
  }> = [];
  const updatedRows: Array<{ rowNumber: number; productId: string }> = [];
  const failedRows: Array<{ rowNumber: number; issues: ProductImportIssue[] }> = [];
  const skippedRows: Array<{ rowNumber: number; issues: ProductImportIssue[] }> = preview.rows
    .filter(row => row.status === 'duplicate')
    .map(row => ({ rowNumber: row.rowNumber, issues: row.issues }));

  for (const row of preview.rows) {
    if (row.status === 'update' && row.existing && row.changes) {
      try {
        await updateProduct(ctx, {
          id: row.existing.productId,
          version: row.existing.version,
          ...row.changes,
        });
        updatedRows.push({ rowNumber: row.rowNumber, productId: row.existing.productId });
      } catch (error) {
        if (isConflictError(error)) {
          skippedRows.push({
            rowNumber: row.rowNumber,
            issues: [{ code: 'concurrent_update', field: 'sku' }],
          });
          continue;
        }
        log.error(
          {
            ...getSafeImportErrorMetadata(error),
            tenantId: ctx.tenantId,
            importId,
            rowNumber: row.rowNumber,
          },
          'product import update failed'
        );
        failedRows.push({
          rowNumber: row.rowNumber,
          issues: [{ code: 'import_failed', field: 'sku' }],
        });
      }
      continue;
    }
    if (row.status !== 'ready') continue;
    try {
      const created = await createProductForImport(ctx, {
        name: row.normalized.name,
        sku: row.normalized.sku,
        description: row.normalized.description,
        price: row.normalized.price,
        price2: 0,
        price3: 0,
        cost: row.normalized.cost,
        marginPercent1: 0,
        marginPercent2: 0,
        marginPercent3: 0,
        marginAmount1: 0,
        marginAmount2: 0,
        marginAmount3: 0,
        taxRate: row.normalized.taxRate,
        vatRateId: row.normalized.vatRateId,
        initialCost: row.normalized.cost,
        stock: 0,
        minStock: row.normalized.minStock,
        sellByFraction: false,
        tracksStock: row.normalized.tracksStock,
        tracksLots: row.normalized.tracksLots,
        tracksSerials: false,
        isActive: true,
        barcode: row.normalized.barcode,
        unitAssignments: row.normalized.unitId
          ? [
              {
                unitId: row.normalized.unitId,
                equivalence: 1,
                price: row.normalized.price,
                price2: 0,
                price3: 0,
                isBase: true,
              },
            ]
          : undefined,
      });

      const issues: ProductImportIssue[] = [];
      // Count only durable opening-ledger entries. A product with zero (or
      // unmapped) opening stock needs no inventory mutation and must not make
      // the completion report claim that stock was recorded.
      let stockInitialized = false;
      if (row.normalized.tracksStock && row.normalized.stock > 0) {
        const baseUnit = created.unitAssignments.find(assignment => assignment.isBase);
        if (!baseUnit) {
          issues.push({ code: 'stock_failed', field: 'stock' });
        } else {
          try {
            await recordInventoryEntry(ctx, {
              productId: created.id,
              unitId: baseUnit.unitId,
              mode: 'initial',
              quantity: row.normalized.stock,
              cost: row.normalized.cost,
              notes: `Launch import ${importId}`,
            });
            stockInitialized = true;
          } catch (error) {
            log.warn(
              {
                ...getSafeImportErrorMetadata(error),
                tenantId: ctx.tenantId,
                importId,
                rowNumber: row.rowNumber,
                productId: created.id,
              },
              'opening stock import failed'
            );
            issues.push({ code: 'stock_failed', field: 'stock' });
          }
        }
      }
      importedRows.push({
        rowNumber: row.rowNumber,
        productId: created.id,
        stockInitialized,
        issues,
      });
    } catch (error) {
      if (isConflictError(error)) {
        skippedRows.push({
          rowNumber: row.rowNumber,
          issues: [{ code: 'concurrent_duplicate', field: 'sku' }],
        });
        continue;
      }
      log.error(
        {
          ...getSafeImportErrorMetadata(error),
          tenantId: ctx.tenantId,
          importId,
          rowNumber: row.rowNumber,
        },
        'product import row failed'
      );
      failedRows.push({
        rowNumber: row.rowNumber,
        issues: [{ code: 'import_failed', field: 'sku' }],
      });
    }
  }

  const completedAt = new Date().toISOString();
  const skipped = skippedRows.length;
  const warnings = importedRows.reduce((count, row) => count + row.issues.length, 0);
  // Audit-chain writes read the current head before appending. Reserve the
  // SQLite writer up front so another import cannot make that read transaction
  // fail while upgrading to a write under normal multi-register contention.
  ctx.db.transaction(
    tx => {
      writeAuditLog({
        tx,
        tenantId: ctx.tenantId,
        actorId: ctx.user.id,
        action: 'data_import.products',
        resourceType: 'data_import',
        resourceId: importId,
        after: {
          imported: importedRows.length,
          updated: updatedRows.length,
          unchanged: preview.summary.unchanged,
          stockInitialized: importedRows.filter(row => row.stockInitialized).length,
          skipped,
          invalid: preview.summary.invalid,
          failed: failedRows.length,
        },
        metadata: {
          dataMode: input.dataMode,
          importMode: input.importMode,
          sourceFormat: getImportSourceFormat(input.sourceName),
          previewHash: input.previewHash,
          totalRows: preview.summary.total,
          warnings,
        },
      });
    },
    { behavior: 'immediate' }
  );

  return {
    dataMode: input.dataMode,
    importId,
    completedAt,
    summary: {
      total: preview.summary.total,
      imported: importedRows.length,
      updated: updatedRows.length,
      unchanged: preview.summary.unchanged,
      stockInitialized: importedRows.filter(row => row.stockInitialized).length,
      skipped,
      invalid: preview.summary.invalid,
      failed: failedRows.length,
      warnings,
    },
    importedRows,
    updatedRows,
    skippedRows,
    failedRows,
  };
}
