/** Merge per-batch server previews and reports into one operator-facing result. */
import type { ProductImportPreview, ProductImportReport } from './types';

export function mergeProductImportPreviews(
  previews: readonly ProductImportPreview[]
): ProductImportPreview {
  const [first] = previews;
  if (!first) throw new Error('At least one preview batch is required');
  if (previews.length === 1) return first;
  const summary = { ...first.summary };
  for (const preview of previews.slice(1)) {
    for (const key of Object.keys(summary) as Array<keyof typeof summary>) {
      summary[key] += preview.summary[key];
    }
  }
  return {
    ...first,
    previewHash: previews.map(preview => preview.previewHash).join(':'),
    summary,
    rows: previews.flatMap(preview => preview.rows),
  };
}

export function mergeProductImportReports(
  reports: readonly ProductImportReport[]
): ProductImportReport {
  const [first] = reports;
  if (!first) throw new Error('At least one report batch is required');
  if (reports.length === 1) return first;
  const summary = { ...first.summary };
  for (const report of reports.slice(1)) {
    for (const key of Object.keys(summary) as Array<keyof typeof summary>) {
      summary[key] += report.summary[key];
    }
  }
  return {
    ...first,
    importId: reports.map(report => report.importId).join(', '),
    completedAt: reports.at(-1)!.completedAt,
    summary,
    importedRows: reports.flatMap(report => report.importedRows),
    updatedRows: reports.flatMap(report => report.updatedRows),
    skippedRows: reports.flatMap(report => report.skippedRows),
    failedRows: reports.flatMap(report => report.failedRows),
  };
}
