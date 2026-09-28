/** Browser-only CSV/XLSX reader for the launch import workbench. */

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_COLUMNS = 50;

export type ImportFileErrorCode =
  | 'unsupported_file'
  | 'file_too_large'
  | 'empty_file'
  | 'empty_header'
  | 'duplicate_header'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'row_too_wide'
  | 'malformed_csv'
  | 'workbook_empty';

export class ImportFileError extends Error {
  constructor(readonly code: ImportFileErrorCode) {
    super(code);
    this.name = 'ImportFileError';
  }
}

export interface ParsedImportRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedImportFile {
  sourceName: string;
  headers: string[];
  rows: ParsedImportRow[];
}

function validateHeaders(rawHeaders: string[]): string[] {
  if (rawHeaders.length === 0 || rawHeaders.every(header => header.trim().length === 0)) {
    throw new ImportFileError('empty_header');
  }
  if (rawHeaders.length > MAX_IMPORT_COLUMNS) throw new ImportFileError('too_many_columns');

  const headers = rawHeaders.map(header => header.trim());
  if (headers.some(header => header.length === 0)) throw new ImportFileError('empty_header');
  const keys = headers.map(header =>
    header
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('en-US')
  );
  if (new Set(keys).size !== keys.length) throw new ImportFileError('duplicate_header');
  return headers;
}

function buildRows(
  sourceName: string,
  matrix: string[][],
  sourceRowNumbers?: number[]
): ParsedImportFile {
  if (matrix.length === 0) throw new ImportFileError('empty_file');
  const headers = validateHeaders(matrix[0] ?? []);
  const rows = matrix
    .slice(1)
    .map((cells, index) => ({
      cells,
      rowNumber: sourceRowNumbers?.[index + 1] ?? index + 2,
    }))
    .filter(({ cells }) => cells.some(cell => cell.trim().length > 0))
    .map(({ cells, rowNumber }) => {
      if (cells.slice(headers.length).some(cell => cell.trim().length > 0)) {
        throw new ImportFileError('row_too_wide');
      }
      return {
        rowNumber,
        values: Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
      };
    });
  if (rows.length === 0) throw new ImportFileError('empty_file');
  if (rows.length > MAX_IMPORT_ROWS) throw new ImportFileError('too_many_rows');
  return { sourceName, headers, rows };
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const candidates = [',', ';', '\t'] as const;
  const counts = new Map<(typeof candidates)[number], number>(candidates.map(value => [value, 0]));
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) break;
    if (!quoted && candidates.includes(char as (typeof candidates)[number])) {
      const candidate = char as (typeof candidates)[number];
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }
  return candidates.reduce((best, candidate) =>
    (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0) ? candidate : best
  );
}

function csvTextToMatrix(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) throw new ImportFileError('empty_file');
  const delimiter = detectDelimiter(clean);
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]!;
    if (quoted) {
      if (char === '"' && clean[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        cell += char;
      }
      continue;
    }
    if (closedQuote && char !== delimiter && char !== '\n' && char !== '\r') {
      throw new ImportFileError('malformed_csv');
    }
    if (char === '"') {
      if (cell.length > 0) throw new ImportFileError('malformed_csv');
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[index + 1] === '\n') index += 1;
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new ImportFileError('malformed_csv');
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    matrix.push(row);
  }
  return matrix;
}

export function parseCsvText(text: string, sourceName = 'import.csv'): ParsedImportFile {
  return buildRows(sourceName, csvTextToMatrix(text));
}

function spreadsheetValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Never evaluate formulas. ExcelJS only exposes a cached result; use it
    // when present and otherwise leave the cell empty.
    if ('formula' in record || 'sharedFormula' in record) {
      return spreadsheetValueToString(record.result);
    }
    if (typeof record.text === 'string') return record.text;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map(part =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        )
        .join('');
    }
  }
  return String(value);
}

async function parseXlsxFile(file: File): Promise<ParsedImportFile> {
  const { default: ExcelJS } = await import('exceljs/dist/exceljs.bare.min.js');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new ImportFileError('workbook_empty');
  const matrix: string[][] = [];
  const sourceRowNumbers: number[] = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    if (row.cellCount > MAX_IMPORT_COLUMNS) {
      const hasOverflowValue = Array.from(
        { length: row.cellCount - MAX_IMPORT_COLUMNS },
        (_, index) => spreadsheetValueToString(row.getCell(MAX_IMPORT_COLUMNS + index + 1).value)
      ).some(value => value.trim().length > 0);
      if (hasOverflowValue) {
        throw new ImportFileError(matrix.length === 0 ? 'too_many_columns' : 'row_too_wide');
      }
    }
    const cells: string[] = [];
    for (let index = 1; index <= Math.min(row.cellCount, MAX_IMPORT_COLUMNS); index += 1) {
      cells.push(spreadsheetValueToString(row.getCell(index).value));
    }
    matrix.push(cells);
    sourceRowNumbers.push(row.number);
  });
  return buildRows(file.name, matrix, sourceRowNumbers);
}

export async function parseImportFile(file: File): Promise<ParsedImportFile> {
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportFileError('file_too_large');
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase();
  if (extension === 'csv') return parseCsvText(await file.text(), file.name);
  if (extension === 'xlsx') return parseXlsxFile(file);
  throw new ImportFileError('unsupported_file');
}

// ---------------------------------------------------------------------------
// Multi-sheet workbook reader for supplier price lists. Unlike
// `parseImportFile`, the header row is not assumed to be row 1: callers pick
// the worksheet and header row (usually through `detectHeaderRowIndex`) and
// then build a `ParsedImportFile` with `buildSheetImportFile`.
// ---------------------------------------------------------------------------

/** Upper bound for a whole workbook import; the server still receives 500-row batches. */
export const MAX_WORKBOOK_IMPORT_ROWS = 20_000;
/** Rows scanned from the top of a sheet when looking for the header row. */
export const HEADER_SCAN_ROWS = 200;

export interface ImportSheet {
  name: string;
  hidden: boolean;
  /** Non-empty source rows, each truncated to `MAX_IMPORT_COLUMNS` cells. */
  cells: string[][];
  /** 1-based spreadsheet row number for each entry of `cells`. */
  rowNumbers: number[];
}

export interface ImportWorkbook {
  sourceName: string;
  sheets: ImportSheet[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Spreadsheet numbers arrive as IEEE doubles (`255.09060000000002`). Round
 * to 15 significant digits so the text the server parses is the value the
 * operator saw in Excel.
 */
function workbookValueToString(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    if ('formula' in record || 'sharedFormula' in record) {
      return workbookValueToString(record.result);
    }
  }
  return spreadsheetValueToString(value);
}

function pushSheetRow(sheet: ImportSheet, rowNumber: number, values: readonly unknown[]): void {
  const cells = values.slice(0, MAX_IMPORT_COLUMNS).map(workbookValueToString);
  while (cells.length > 0 && cells.at(-1)!.trim() === '') cells.pop();
  if (cells.length === 0) return;
  if (sheet.cells.length >= MAX_WORKBOOK_IMPORT_ROWS + HEADER_SCAN_ROWS) {
    throw new ImportFileError('too_many_rows');
  }
  sheet.cells.push(cells);
  sheet.rowNumbers.push(rowNumber);
}

async function readXlsxWorkbook(file: File): Promise<ImportSheet[]> {
  const { default: ExcelJS } = await import('exceljs/dist/exceljs.bare.min.js');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  return workbook.worksheets.map(worksheet => {
    const sheet: ImportSheet = {
      name: worksheet.name,
      hidden: worksheet.state !== undefined && worksheet.state !== 'visible',
      cells: [],
      rowNumbers: [],
    };
    worksheet.eachRow({ includeEmpty: false }, row => {
      const values: unknown[] = [];
      for (let index = 1; index <= Math.min(row.cellCount, MAX_IMPORT_COLUMNS); index += 1) {
        const cell = row.getCell(index);
        // ExcelJS repeats a merged value in every covered cell; keep it only
        // in the master cell so a merged title does not look like a header.
        if (cell.isMerged && cell.master.address !== cell.address) {
          values.push('');
          continue;
        }
        values.push(cell.value);
      }
      pushSheetRow(sheet, row.number, values);
    });
    return sheet;
  });
}

async function readXlsWorkbook(file: File): Promise<ImportSheet[]> {
  // Legacy BIFF (.xls) files need SheetJS; load it only for that format.
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
    type: 'array',
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellDates: false,
  });
  const sheetMeta = workbook.Workbook?.Sheets ?? [];
  return workbook.SheetNames.map((name, sheetIndex) => {
    const worksheet = workbook.Sheets[name];
    const sheet: ImportSheet = {
      name,
      hidden: Boolean(sheetMeta[sheetIndex]?.Hidden),
      cells: [],
      rowNumbers: [],
    };
    if (!worksheet || !worksheet['!ref']) return sheet;
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: true,
      defval: '',
      blankrows: true,
    });
    const firstColumnPadding = Array.from({ length: range.s.c }, () => '');
    rows.forEach((values, index) => {
      pushSheetRow(sheet, range.s.r + index + 1, [...firstColumnPadding, ...values]);
    });
    return sheet;
  });
}

function readCsvWorkbook(text: string): ImportSheet[] {
  const sheet: ImportSheet = { name: '', hidden: false, cells: [], rowNumbers: [] };
  csvTextToMatrix(text).forEach((values, index) => pushSheetRow(sheet, index + 1, values));
  return [sheet];
}

/** Read every worksheet of a CSV, XLSX, or legacy XLS file without assuming a header row. */
export async function readImportWorkbook(file: File): Promise<ImportWorkbook> {
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new ImportFileError('file_too_large');
  const extension = file.name.split('.').at(-1)?.toLocaleLowerCase();
  let sheets: ImportSheet[];
  if (extension === 'csv') sheets = readCsvWorkbook(await file.text());
  else if (extension === 'xlsx') sheets = await readXlsxWorkbook(file);
  else if (extension === 'xls') sheets = await readXlsWorkbook(file);
  else throw new ImportFileError('unsupported_file');
  if (sheets.length === 0) throw new ImportFileError('workbook_empty');
  if (sheets.every(sheet => sheet.cells.length === 0)) throw new ImportFileError('empty_file');
  return { sourceName: file.name, sheets };
}

/**
 * Pick the header row among the first `HEADER_SCAN_ROWS` rows: the row with
 * the highest `scoreRow` result wins (earliest on ties). Returns 0 when no
 * row scores at least `minimumScore`.
 */
export function detectHeaderRowIndex(
  sheet: ImportSheet,
  scoreRow: (cells: string[]) => number,
  minimumScore = 2
): number {
  let bestIndex = 0;
  let bestScore = minimumScore - 1;
  const limit = Math.min(sheet.cells.length, HEADER_SCAN_ROWS);
  for (let index = 0; index < limit; index += 1) {
    const score = scoreRow(sheet.cells[index]!);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function headerKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US');
}

/**
 * Build a `ParsedImportFile` from one worksheet using `headerIndex` (an index
 * into `sheet.cells`) as the header row. Columns without a header are ignored,
 * repeated headers get a numeric suffix, and rows that repeat the header
 * (page breaks in exported price lists) are skipped.
 */
export function buildSheetImportFile(
  sourceName: string,
  sheet: ImportSheet,
  headerIndex: number
): ParsedImportFile {
  const headerCells = sheet.cells[headerIndex];
  if (!headerCells) throw new ImportFileError('empty_file');
  const columns: Array<{ index: number; header: string }> = [];
  const seen = new Map<string, number>();
  headerCells.forEach((raw, index) => {
    const header = collapseWhitespace(raw);
    if (!header) return;
    const key = headerKey(header);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    columns.push({ index, header: count === 1 ? header : `${header} (${count})` });
  });
  if (columns.length === 0) throw new ImportFileError('empty_header');

  const headerSignature = columns.map(column =>
    headerKey(collapseWhitespace(headerCells[column.index]!))
  );
  const rows: ParsedImportRow[] = [];
  for (let index = headerIndex + 1; index < sheet.cells.length; index += 1) {
    const cells = sheet.cells[index]!;
    const values = columns.map(column => (cells[column.index] ?? '').trim());
    if (values.every(value => value.length === 0)) continue;
    if (
      values.every(
        (value, position) => headerKey(collapseWhitespace(value)) === headerSignature[position]
      )
    ) {
      continue;
    }
    rows.push({
      rowNumber: sheet.rowNumbers[index] ?? index + 1,
      values: Object.fromEntries(
        columns.map((column, position) => [column.header, values[position]!])
      ),
    });
  }
  if (rows.length === 0) throw new ImportFileError('empty_file');
  if (rows.length > MAX_WORKBOOK_IMPORT_ROWS) throw new ImportFileError('too_many_rows');
  return { sourceName, headers: columns.map(column => column.header), rows };
}
