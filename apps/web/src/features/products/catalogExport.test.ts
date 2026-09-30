import { describe, expect, it, vi } from 'vitest';
import { editableProductColumns, fetchCatalogForExport } from './catalogExport';
import { autoMapProductHeaders } from '@/features/data-import/productImportMapping';

describe('catalog export', () => {
  it('fetches all pages before exporting rather than only the visible page', async () => {
    const fetchPage = vi.fn(async (page: number) => ({
      items: [{ id: `p-${page}` }],
      totalItems: 3,
      totalPages: 3,
    }));
    const progress = vi.fn();
    expect(await fetchCatalogForExport(fetchPage, progress)).toEqual([
      { id: 'p-1' },
      { id: 'p-2' },
      { id: 'p-3' },
    ]);
    expect(fetchPage.mock.calls).toEqual([[1], [2], [3]]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it('exports selected IDs across pages, not array indices', async () => {
    const rows = await fetchCatalogForExport(
      async page => ({ items: [{ id: `p-${page}` }], totalItems: 2, totalPages: 2 }),
      () => {},
      new Set(['p-2'])
    );
    expect(rows).toEqual([{ id: 'p-2' }]);
  });

  it('fails closed on missing or duplicate pages', async () => {
    await expect(
      fetchCatalogForExport(
        async () => ({ items: [{ id: 'same' }], totalItems: 2, totalPages: 2 }),
        () => {}
      )
    ).rejects.toThrow('changed');
  });

  it('uses importable columns with raw numeric values', () => {
    expect(
      autoMapProductHeaders(editableProductColumns.map(column => column.header))
    ).toMatchObject({
      productId: 'Product ID',
      productVersion: 'Product Version',
      name: 'Product',
      sku: 'SKU',
      cost: 'Cost',
      price: 'Price',
      taxRate: 'Tax rate',
    });
    expect(
      editableProductColumns.find(column => column.key === 'price')?.formatter
    ).toBeUndefined();
  });
});
