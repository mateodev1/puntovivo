/**
 * Worksheet, header-row, and column detection for product files whose
 * header is not on row 1 (supplier price lists exported from other systems).
 */
import {
  buildSheetImportFile,
  detectHeaderRowIndex,
  type ImportSheet,
  type ImportWorkbook,
  type ParsedImportFile,
} from './fileParser';
import { normalizeImportHeader } from './mappingUtils';
import {
  autoMapProductHeaders,
  PRODUCT_IMPORT_FIELDS,
  type ProductImportMapping,
} from './productImportMapping';

export const PRODUCT_IMPORT_MODES = ['create', 'upsert'] as const;
export type ProductImportMode = (typeof PRODUCT_IMPORT_MODES)[number];

/** Rows sent to the server per preview/commit request. */
export const PRODUCT_IMPORT_BATCH_SIZE = 500;

const SKU_HEADERS = new Set([
  'sku',
  'cod',
  'codigo',
  'codigo interno',
  'codigo producto',
  'codigo articulo',
  'cod articulo',
  'articulo',
  'referencia',
  'ref',
  'item',
  'code',
]);
const NAME_HEADERS = new Set([
  'name',
  'nombre',
  'nombre producto',
  'nombre del producto',
  'producto',
  'product',
  'product name',
  'desc',
  'descripcion',
  'descripcion articulo',
  'detalle',
  'description',
]);
const TAX_HEADERS = new Set([
  'iva',
  'i v a',
  'alicuota',
  'alicuota iva',
  'impuesto',
  'tasa impuesto',
  'tasa de impuesto',
  'porcentaje iva',
  'tax rate',
  'vat',
]);
const PRICE_WORDS = new Set(['precio', 'costo', 'neto', 'price', 'cost']);
const NON_PRICE_WORDS = new Set([
  'porcentaje',
  'variacion',
  'cambio',
  'subtotal',
  'total',
  'cantidad',
  'fecha',
]);

/** True for price-like columns (list price, net price, cost), which are cost candidates. */
export function isPriceLikeHeader(header: string): boolean {
  const normalized = normalizeImportHeader(header);
  const words = normalized.split(' ');
  if (words.some(word => NON_PRICE_WORDS.has(word))) return false;
  return words.some(word => PRICE_WORDS.has(word)) || normalized.startsWith('pre lista');
}

/** Score how much a row looks like a product header row. */
export function scoreProductHeaderRow(cells: string[]): number {
  let sku = 0;
  let name = 0;
  let tax = 0;
  let prices = 0;
  let other = 0;
  const generic = autoMapProductHeaders(cells.filter(cell => cell.trim().length > 0));
  for (const cell of cells) {
    const key = normalizeImportHeader(cell);
    if (!key) continue;
    if (SKU_HEADERS.has(key)) sku = 1;
    else if (NAME_HEADERS.has(key)) name = 1;
    else if (TAX_HEADERS.has(key)) tax = 1;
    else if (isPriceLikeHeader(cell)) prices += 1;
  }
  for (const field of ['barcode', 'unit', 'stock', 'minStock'] as const) {
    if (generic[field]) other += 1;
  }
  return sku + name + tax + Math.min(prices, 2) + other;
}

export interface ProductImportSheetCandidate {
  sheetIndex: number;
  headerIndex: number;
  score: number;
  dataRows: number;
}

export function detectProductHeaderIndex(sheet: ImportSheet): number {
  return detectHeaderRowIndex(sheet, scoreProductHeaderRow);
}

/**
 * Choose the worksheet most likely to hold the product list: visible sheets
 * first, then the best header score, then the most data rows.
 */
export function selectProductImportSheet(workbook: ImportWorkbook): ProductImportSheetCandidate {
  const candidates = workbook.sheets.map((sheet, sheetIndex) => {
    const headerIndex = detectProductHeaderIndex(sheet);
    return {
      sheetIndex,
      headerIndex,
      score: sheet.cells[headerIndex] ? scoreProductHeaderRow(sheet.cells[headerIndex]) : 0,
      dataRows: Math.max(sheet.cells.length - headerIndex - 1, 0),
      hidden: sheet.hidden,
    };
  });
  const usable = candidates.filter(candidate => candidate.dataRows > 0);
  const pool = usable.some(candidate => !candidate.hidden)
    ? usable.filter(candidate => !candidate.hidden)
    : usable;
  const best = [...pool].sort(
    (left, right) =>
      right.score - left.score ||
      right.dataRows - left.dataRows ||
      left.sheetIndex - right.sheetIndex
  )[0] ?? { sheetIndex: 0, headerIndex: 0, score: 0, dataRows: 0 };
  return {
    sheetIndex: best.sheetIndex,
    headerIndex: best.headerIndex,
    score: best.score,
    dataRows: best.dataRows,
  };
}

export function buildProductImportFile(
  workbook: ImportWorkbook,
  sheetIndex: number,
  headerIndex: number
): ParsedImportFile {
  const sheet = workbook.sheets[sheetIndex];
  if (!sheet) throw new Error(`Unknown worksheet ${sheetIndex}`);
  return buildSheetImportFile(workbook.sourceName, sheet, headerIndex);
}

function emptyMapping(): ProductImportMapping {
  return Object.fromEntries(
    PRODUCT_IMPORT_FIELDS.map(field => [field, ''])
  ) as ProductImportMapping;
}

/** Name falls back to a description column when the file has no name column. */
export function withNameFallback(
  headers: string[],
  mapping: ProductImportMapping
): ProductImportMapping {
  if (mapping.name) return mapping;
  const fallback = headers.find(header => NAME_HEADERS.has(normalizeImportHeader(header)));
  if (!fallback) return mapping;
  return {
    ...mapping,
    name: fallback,
    description: mapping.description === fallback ? '' : mapping.description,
  };
}

export interface SupplierMappingResult {
  mapping: ProductImportMapping;
  /** Price-like columns; when more than one, the operator must choose the cost column. */
  costCandidates: string[];
}

/**
 * Supplier price lists carry the supplier's prices, which are the store's
 * cost. Never auto-map a sale price here, and only auto-map the cost when
 * exactly one price-like column exists.
 */
export function autoMapSupplierHeaders(headers: string[]): SupplierMappingResult {
  const mapping = emptyMapping();
  const find = (candidates: Set<string>) =>
    headers.find(header => candidates.has(normalizeImportHeader(header))) ?? '';
  mapping.sku = find(SKU_HEADERS);
  mapping.name =
    headers.find(
      header => header !== mapping.sku && NAME_HEADERS.has(normalizeImportHeader(header))
    ) ?? '';
  mapping.taxRate = find(TAX_HEADERS);
  const generic = autoMapProductHeaders(headers);
  mapping.barcode = generic.barcode;
  mapping.unit = generic.unit;
  const costCandidates = headers.filter(isPriceLikeHeader);
  if (costCandidates.length === 1) mapping.cost = costCandidates[0]!;
  return { mapping, costCandidates };
}

export interface ProductRowTransformOptions {
  skuPrefix: string;
  /** Applied when the row has no tax name or rate; blank keeps the row untouched. */
  defaultTaxRate: string;
}

type MappedRow = {
  rowNumber: number;
  values: Partial<Record<(typeof PRODUCT_IMPORT_FIELDS)[number], string>>;
};

export function applyProductRowOptions<T extends MappedRow>(
  rows: T[],
  options: ProductRowTransformOptions
): T[] {
  const prefix = options.skuPrefix.trim();
  const defaultTax = options.defaultTaxRate.trim();
  if (!prefix && !defaultTax) return rows;
  return rows.map(row => {
    const values = { ...row.values };
    const sku = values.sku?.trim();
    if (prefix && sku) values.sku = `${prefix}${sku}`;
    if (defaultTax && !values.taxRate?.trim() && !values.taxName?.trim()) {
      values.taxRate = defaultTax;
    }
    return { ...row, values };
  });
}

export function chunkRows<T>(rows: T[], size = PRODUCT_IMPORT_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
