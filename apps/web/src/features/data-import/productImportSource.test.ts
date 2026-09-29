import { describe, expect, it } from 'vitest';

import { ImportFileError, readImportWorkbook } from './fileParser';
import { mapProductImportRows } from './productImportMapping';
import {
  applyProductRowOptions,
  autoMapSupplierHeaders,
  buildProductImportFile,
  chunkRows,
  isEditableProductExport,
  selectProductImportSheet,
  withNameFallback,
} from './productImportSource';
import { autoMapProductHeaders } from './productImportMapping';

async function xlsxFile(
  name: string,
  build: (workbook: import('exceljs').Workbook) => void
): Promise<File> {
  const { default: ExcelJS } = await import('exceljs/dist/exceljs.bare.min.js');
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as BlobPart], name);
}

describe('supplier price-list sources', () => {
  it('recognizes editable catalog exports without treating supplier prices as sale prices', () => {
    const headers = ['Product', 'SKU', 'Description', 'Cost', 'Price', 'Tax rate'];
    expect(isEditableProductExport(headers)).toBe(true);
    expect(autoMapProductHeaders(headers)).toMatchObject({
      name: 'Product',
      sku: 'SKU',
      cost: 'Cost',
      price: 'Price',
      taxRate: 'Tax rate',
    });
    expect(isEditableProductExport(['Código', 'Descripción', 'Precio'])).toBe(false);
    expect(autoMapSupplierHeaders(['Código', 'Descripción', 'Precio']).mapping.price).toBe('');
  });
  it('skips a merged title and notes to find a header below row 1 (LEKONS shape)', async () => {
    const file = await xlsxFile('LEKONS.xlsx', workbook => {
      const sheet = workbook.addWorksheet('Hoja 1');
      sheet.getCell('A1').value = 'LISTA DE PRECIOS EXCEL - ACTUALIZADA EL 24/07/2026';
      sheet.mergeCells('A1:E1');
      sheet.getCell('A2').value = 'Precios sujetos a variación sin previo aviso.';
      sheet.mergeCells('A2:E2');
      sheet.getRow(4).values = [
        'Código',
        'Descripción',
        'Precio',
        'Porcentaje de cambio',
        'PRECIO NETO(INCLUYE DESCUENTO 40% + 10% por pago)',
      ];
      sheet.getRow(5).values = ['AAF0000', 'CODO 90º ø 20', 472.39, 0, 255.09060000000002];
      sheet.getRow(7).values = ['AAF0001', 'CODO 90º ø 25', 741.65, 0, 400.491];
    });

    const workbook = await readImportWorkbook(file);
    const candidate = selectProductImportSheet(workbook);
    expect(workbook.sheets[0]!.rowNumbers[candidate.headerIndex]).toBe(4);

    const parsed = buildProductImportFile(workbook, candidate.sheetIndex, candidate.headerIndex);
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        rowNumber: 5,
        values: expect.objectContaining({
          Código: 'AAF0000',
          'PRECIO NETO(INCLUYE DESCUENTO 40% + 10% por pago)': '255.0906',
        }),
      }),
      expect.objectContaining({ rowNumber: 7 }),
    ]);

    const supplier = autoMapSupplierHeaders(parsed.headers);
    expect(supplier.mapping).toMatchObject({
      sku: 'Código',
      name: 'Descripción',
      price: '',
      cost: '',
    });
    expect(supplier.costCandidates).toEqual([
      'Precio',
      'PRECIO NETO(INCLUYE DESCUENTO 40% + 10% por pago)',
    ]);
  });

  it('prefers the visible product sheet over hidden and quotation sheets (DILMAS shape)', async () => {
    const file = await xlsxFile('DILMAS.xlsx', workbook => {
      const hidden = workbook.addWorksheet('MODIFICACIONES (9)', { state: 'hidden' });
      hidden.addRow(['COD', 'DESC', 'PRE.LISTA', 'IVA']);
      for (let index = 0; index < 5; index += 1) hidden.addRow([index, 'Oculto', 1, 21]);

      const list = workbook.addWorksheet('Lista de Precios');
      list.getRow(94).values = ['Nota: los importes están expresados sin IVA.'];
      list.getRow(95).values = [
        'CÓDIGO',
        'DESCRIPCIÓN',
        'BONIFICACIÓN',
        '%',
        'Precio de\nLista',
        'Precio\nc/Bonificación',
        'I.V.A.',
      ];
      list.getRow(96).values = [150087, 'Parche reparador', '-', 0, 8404.7355, 8404.7355, 0.21];
      list.getRow(97).values = [12801, 'Disco flap', '10% de desc.', 10, 1979.1114, 1781.2, 0.105];

      const quote = workbook.addWorksheet('Cotizar (beta)');
      quote.getRow(3).values = ['BUSCAR POR', 'CANTIDAD', 'ARTICULO', 'DESCRIPCION'];
      quote.getRow(4).values = ['3809 - Media sombra', 50, 3809, 'Media sombra'];
    });

    const workbook = await readImportWorkbook(file);
    expect(workbook.sheets.map(sheet => [sheet.name, sheet.hidden])).toEqual([
      ['MODIFICACIONES (9)', true],
      ['Lista de Precios', false],
      ['Cotizar (beta)', false],
    ]);
    const candidate = selectProductImportSheet(workbook);
    expect(candidate.sheetIndex).toBe(1);

    const parsed = buildProductImportFile(workbook, candidate.sheetIndex, candidate.headerIndex);
    expect(parsed.headers).toContain('Precio c/Bonificación');
    const supplier = autoMapSupplierHeaders(parsed.headers);
    expect(supplier.mapping).toMatchObject({
      sku: 'CÓDIGO',
      name: 'DESCRIPCIÓN',
      taxRate: 'I.V.A.',
    });
    expect(supplier.costCandidates).toEqual(['Precio de Lista', 'Precio c/Bonificación']);

    const rows = mapProductImportRows(parsed, {
      ...supplier.mapping,
      cost: 'Precio c/Bonificación',
    });
    expect(rows).toEqual([
      {
        rowNumber: 96,
        values: {
          name: 'Parche reparador',
          sku: '150087',
          cost: '8404.7355',
          taxRate: '0.21',
        },
      },
      {
        rowNumber: 97,
        values: { name: 'Disco flap', sku: '12801', cost: '1781.2', taxRate: '0.105' },
      },
    ]);
  });

  it('reads legacy .xls workbooks (FOX shape)', async () => {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      [],
      ['', 'LISTA DE PRECIOS Nº 153 ACTUALIZADA (21-09-2026)'],
      ['Código', 'Descripción', 'Precio LISTA', 'Precio NETO'],
      [133, 'ECOTERMO 53 LT', 556568.5243, 322816.846064],
      [134, 'ECOTERMO 70 LT', 608539.8799, 352960.895481],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'A');
    const bytes = XLSX.write(book, { bookType: 'xls', type: 'array' }) as ArrayBuffer;

    const workbook = await readImportWorkbook(new File([bytes], 'FOX Nº153.xls'));
    const candidate = selectProductImportSheet(workbook);
    const parsed = buildProductImportFile(workbook, candidate.sheetIndex, candidate.headerIndex);
    expect(parsed.headers).toEqual(['Código', 'Descripción', 'Precio LISTA', 'Precio NETO']);
    expect(parsed.rows[0]).toEqual({
      rowNumber: 4,
      values: {
        Código: '133',
        Descripción: 'ECOTERMO 53 LT',
        'Precio LISTA': '556568.5243',
        'Precio NETO': '322816.846064',
      },
    });
  });

  it('keeps row-1 CSV headers, repeated headers, and page-break header rows readable', async () => {
    const workbook = await readImportWorkbook(
      new File(
        [
          'Name,SKU,Price,Price,\n',
          'Coffee,C-1,10,11,\n',
          'Name,SKU,Price,Price,\n',
          'Tea,T-1,5,6,\n',
        ],
        'catalog.csv'
      )
    );
    const candidate = selectProductImportSheet(workbook);
    expect(candidate.headerIndex).toBe(0);
    const parsed = buildProductImportFile(workbook, 0, 0);
    expect(parsed.headers).toEqual(['Name', 'SKU', 'Price', 'Price (2)']);
    expect(parsed.rows.map(row => row.rowNumber)).toEqual([2, 4]);
  });

  it('rejects unsupported extensions with a typed error', async () => {
    await expect(readImportWorkbook(new File(['x'], 'lista.pdf'))).rejects.toBeInstanceOf(
      ImportFileError
    );
  });

  it('falls back to the description column for the product name', () => {
    const headers = ['Código', 'Descripción', 'Precio'];
    expect(withNameFallback(headers, autoMapProductHeaders(headers))).toMatchObject({
      name: 'Descripción',
      description: '',
      sku: 'Código',
    });
  });

  it('applies the code prefix and default tax without overriding file values', () => {
    const rows = applyProductRowOptions(
      [
        { rowNumber: 2, values: { sku: '133', name: 'A' } },
        { rowNumber: 3, values: { sku: '134', name: 'B', taxRate: '10.5' } },
        { rowNumber: 4, values: { sku: '', name: 'C' } },
      ],
      { skuPrefix: ' FOX- ', defaultTaxRate: '21' }
    );
    expect(rows.map(row => row.values)).toEqual([
      { sku: 'FOX-133', name: 'A', taxRate: '21' },
      { sku: 'FOX-134', name: 'B', taxRate: '10.5' },
      { sku: '', name: 'C', taxRate: '21' },
    ]);
  });

  it('splits large files into server-sized batches', () => {
    const rows = Array.from({ length: 1201 }, (_, index) => index);
    expect(chunkRows(rows).map(chunk => chunk.length)).toEqual([500, 500, 201]);
  });
});
