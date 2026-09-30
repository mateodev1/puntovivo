import type { Product } from '@/types';
import type { ExportColumn } from '@/services/export/exportService';

/** ID anchors updates even when the operator edits the SKU. */
export const editableProductColumns: ExportColumn<Product>[] = [
  { key: 'id', header: 'Product ID' },
  { key: 'version', header: 'Product Version' },
  { key: 'name', header: 'Product' },
  { key: 'sku', header: 'SKU' },
  { key: 'description', header: 'Description' },
  { key: 'cost', header: 'Cost' },
  { key: 'price', header: 'Price' },
  { key: 'taxRate', header: 'Tax rate' },
];

type CatalogPage<T> = { items: T[]; totalItems: number; totalPages: number };

/** Fail rather than silently download a truncated or inconsistent catalog. */
export async function fetchCatalogForExport<T extends { id: string }>(
  fetchPage: (page: number) => Promise<CatalogPage<T>>,
  onProgress: (done: number, total: number) => void,
  selectedIds?: ReadonlySet<string>
): Promise<T[]> {
  const first = await fetchPage(1);
  const rows = [...first.items];
  onProgress(rows.length, first.totalItems);
  for (let page = 2; page <= first.totalPages; page++) {
    const next = await fetchPage(page);
    if (next.totalItems !== first.totalItems || next.totalPages !== first.totalPages) {
      throw new Error('The catalog changed during export. Please retry.');
    }
    rows.push(...next.items);
    onProgress(rows.length, first.totalItems);
  }
  if (rows.length !== first.totalItems || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('The catalog changed during export. Please retry.');
  }
  if (!selectedIds) return rows;
  const selected = rows.filter(row => selectedIds.has(row.id));
  if (selected.length !== selectedIds.size) {
    throw new Error('Some selected products no longer match the filters. Please retry.');
  }
  return selected;
}
