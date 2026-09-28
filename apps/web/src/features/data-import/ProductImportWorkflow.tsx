import { FileSpreadsheet, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/feedback/ToastProvider';
import { exportToCSV, type ExportColumn } from '@/services/export/exportService';
import { onErrorToast } from '@/lib/mutationHelpers';
import { trpc } from '@/lib/trpc';
import {
  ImportFileError,
  readImportWorkbook,
  type ImportFileErrorCode,
  type ImportWorkbook,
  type ParsedImportFile,
} from './fileParser';
import { ImportSourcePanel } from './ImportSourcePanel';
import {
  hasRequiredProductMapping,
  mapProductImportRows,
  type ProductImportField,
  type ProductImportMapping,
} from './productImportMapping';
import {
  buildProductImportProfileMapping,
  detectProductImportProfile,
  type ProductImportProfileId,
} from './productImportProfiles';
import { ProductImportMappingPanel } from './ProductImportMappingPanel';
import { mergeProductImportPreviews, mergeProductImportReports } from './productImportBatches';
import {
  applyProductRowOptions,
  autoMapSupplierHeaders,
  buildProductImportFile,
  chunkRows,
  detectProductHeaderIndex,
  selectProductImportSheet,
  withNameFallback,
  type ProductImportMode,
} from './productImportSource';
import { ProductImportSourcePanel } from './ProductImportSourcePanel';
import { ProductImportPreviewPanel } from './ProductImportPreview';
import { ProductImportReportPanel } from './ProductImportReport';
import { buildProductImportReportRows } from './productImportReportRows';
import type { LaunchImportDataMode, ProductImportPreview, ProductImportReport } from './types';
import { Button } from '@/components/ui';
type DecimalFormat = 'auto' | 'dot' | 'comma';
const PRODUCT_FILE_ACCEPT =
  '.csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
const FILE_ERROR_KEYS: Partial<Record<ImportFileErrorCode, string>> = {
  unsupported_file: 'unsupported_workbook',
  too_many_rows: 'too_many_workbook_rows',
};
function fileErrorKey(error: unknown): string {
  const code = error instanceof ImportFileError ? error.code : 'unsupported_file';
  return `dataImport:fileErrors.${FILE_ERROR_KEYS[code] ?? code}`;
}
type MappedProductRows = ReturnType<typeof mapProductImportRows>;
interface PreviewBatch {
  rows: MappedProductRows;
  previewHash: string;
}
interface BatchProgress {
  phase: 'preview' | 'import';
  done: number;
  total: number;
}
interface IssueExportRow {
  row: number;
  status: string;
  sku: string;
  field: string;
  issue: string;
}
interface ReportExportRow {
  productId: string;
  stockInitialized: string;
}
const TEMPLATE_KEYS = [
  'name',
  'sku',
  'description',
  'barcode',
  'unit',
  'price',
  'cost',
  'stock',
  'minStock',
  'taxName',
  'taxRate',
  'tracksStock',
  'tracksLots',
] as const;
interface ProductImportWorkflowProps {
  dataMode: LaunchImportDataMode;
  onBusyChange?: (busy: boolean) => void;
}
export function ProductImportWorkflow({ dataMode, onBusyChange }: ProductImportWorkflowProps) {
  const { t } = useTranslation(['dataImport', 'errors']);
  const toast = useToast();
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workbook, setWorkbook] = useState<ImportWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [importMode, setImportMode] = useState<ProductImportMode>('create');
  const [costCandidates, setCostCandidates] = useState<string[]>([]);
  const [skuPrefix, setSkuPrefix] = useState('');
  const [defaultTaxRate, setDefaultTaxRate] = useState('');
  const [batches, setBatches] = useState<PreviewBatch[]>([]);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [file, setFile] = useState<ParsedImportFile | null>(null);
  const [mapping, setMapping] = useState<ProductImportMapping | null>(null);
  const [profileId, setProfileId] = useState<ProductImportProfileId>('generic');
  const [detectedProfileId, setDetectedProfileId] = useState<ProductImportProfileId>('generic');
  const [decimalFormat, setDecimalFormat] = useState<DecimalFormat>('auto');
  const [preview, setPreview] = useState<ProductImportPreview | null>(null);
  const [report, setReport] = useState<ProductImportReport | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmedRealData, setConfirmedRealData] = useState(false);
  const mappedRows = useMemo(
    () =>
      file && mapping
        ? applyProductRowOptions(mapProductImportRows(file, mapping), {
            skuPrefix,
            defaultTaxRate,
          })
        : [],
    [file, mapping, skuPrefix, defaultTaxRate]
  );
  const previewMutation = trpc.launchMigration.previewProducts.useMutation({
    onError: onErrorToast(toast, t, {
      titleKey: 'dataImport:toast.previewError',
    }),
  });
  const importMutation = trpc.launchMigration.importProducts.useMutation({
    onError: onErrorToast(toast, t, {
      titleKey: 'dataImport:toast.importError',
    }),
  });
  const isBusy =
    isParsing || progress !== null || previewMutation.isPending || importMutation.isPending;
  useEffect(() => {
    onBusyChange?.(isBusy);
    return () => onBusyChange?.(false);
  }, [isBusy, onBusyChange]);
  const invalidatePreview = () => {
    setPreview(null);
    setBatches([]);
    setReport(null);
    setConfirmedRealData(false);
    previewMutation.reset();
    importMutation.reset();
  };
  const clearSource = () => {
    setWorkbook(null);
    setFile(null);
    setMapping(null);
    setCostCandidates([]);
    setProfileId('generic');
    setDetectedProfileId('generic');
  };
  const remap = (headers: string[], mode: ProductImportMode) => {
    if (mode === 'upsert') {
      const supplier = autoMapSupplierHeaders(headers);
      setProfileId('generic');
      setDetectedProfileId('generic');
      setMapping(supplier.mapping);
      setCostCandidates(supplier.costCandidates);
      return;
    }
    const detected = detectProductImportProfile(headers);
    setDetectedProfileId(detected);
    setProfileId(detected);
    setMapping(withNameFallback(headers, buildProductImportProfileMapping(headers, detected)));
    setCostCandidates([]);
  };
  /** Rebuild rows and mapping from a worksheet and header row; returns the parsed file. */
  const applySource = (
    source: ImportWorkbook,
    nextSheet: number,
    nextHeader: number,
    mode: ProductImportMode
  ): ParsedImportFile | null => {
    invalidatePreview();
    setSheetIndex(nextSheet);
    setHeaderIndex(nextHeader);
    try {
      const parsed = buildProductImportFile(source, nextSheet, nextHeader);
      setFile(parsed);
      setFileError(null);
      remap(parsed.headers, mode);
      return parsed;
    } catch (error) {
      setFile(null);
      setMapping(null);
      setCostCandidates([]);
      setFileError(t(fileErrorKey(error)));
      return null;
    }
  };
  const handleFile = async (selected: File) => {
    if (isBusy) return;
    setIsParsing(true);
    setFileError(null);
    invalidatePreview();
    try {
      const source = await readImportWorkbook(selected);
      const candidate = selectProductImportSheet(source);
      const parsed = buildProductImportFile(source, candidate.sheetIndex, candidate.headerIndex);
      // Titles or notes above the header row are typical of supplier price
      // lists rather than POS exports, so suggest the supplier-list mode.
      const suggestedMode: ProductImportMode =
        candidate.headerIndex > 0 && detectProductImportProfile(parsed.headers) === 'generic'
          ? 'upsert'
          : 'create';
      setWorkbook(source);
      setImportMode(suggestedMode);
      applySource(source, candidate.sheetIndex, candidate.headerIndex, suggestedMode);
    } catch (error) {
      clearSource();
      if (fileInputRef.current) fileInputRef.current.value = '';
      setFileError(t(fileErrorKey(error)));
    } finally {
      setIsParsing(false);
    }
  };
  const requireCost = importMode === 'upsert';
  const handlePreview = async () => {
    if (!file || !mapping || !hasRequiredProductMapping(mapping, requireCost)) return;
    const chunks = chunkRows(mappedRows);
    const results: ProductImportPreview[] = [];
    setProgress({ phase: 'preview', done: 0, total: chunks.length });
    try {
      for (const [index, rows] of chunks.entries()) {
        results.push(
          await previewMutation.mutateAsync({
            dataMode,
            sourceName: file.sourceName,
            decimalFormat,
            importMode,
            rows,
          })
        );
        setProgress({ phase: 'preview', done: index + 1, total: chunks.length });
      }
      setBatches(chunks.map((rows, index) => ({ rows, previewHash: results[index]!.previewHash })));
      setPreview(mergeProductImportPreviews(results));
      setReport(null);
    } catch {
      // onError already surfaced the failure; keep the mapping for a retry.
    } finally {
      setProgress(null);
    }
  };
  const handleImport = async () => {
    if (!file || !preview || dataMode !== 'real' || !confirmedRealData) return;
    const reports: ProductImportReport[] = [];
    setProgress({ phase: 'import', done: 0, total: batches.length });
    try {
      for (const [index, batch] of batches.entries()) {
        reports.push(
          await importMutation.mutateAsync({
            confirmedRealData: true,
            dataMode,
            sourceName: file.sourceName,
            decimalFormat,
            importMode,
            rows: batch.rows,
            previewHash: batch.previewHash,
          })
        );
        setProgress({ phase: 'import', done: index + 1, total: batches.length });
      }
    } catch {
      // onError already surfaced the failure; report the batches that landed.
    } finally {
      setProgress(null);
    }
    if (reports.length === 0) return;
    const merged = mergeProductImportReports(reports);
    setReport(merged);
    await Promise.all([
      utils.products.list.invalidate(),
      utils.inventory.listStock.invalidate(),
      utils.inventory.listEntries.invalidate(),
      utils.setupReadiness.get.invalidate(),
    ]);
    if (reports.length === batches.length) {
      toast.success({
        title:
          importMode === 'upsert'
            ? t('dataImport:toast.importedUpsert', {
                imported: merged.summary.imported,
                updated: merged.summary.updated,
              })
            : t('dataImport:toast.imported', {
                count: merged.summary.imported,
              }),
      });
    }
  };
  const buildIssueRows = (): IssueExportRow[] => {
    if (!preview) return [];
    if (report) {
      return buildProductImportReportRows(preview, report)
        .filter(row => row.issue !== null)
        .map(row => ({
          row: row.rowNumber,
          status: t(`dataImport:report.statuses.${row.status}`),
          sku: row.sku,
          field: t(`dataImport:fields.${row.issue!.field}`),
          issue: t(`dataImport:issues.${row.issue!.code}`),
        }));
    }
    const rows = preview.rows.flatMap(row =>
      row.issues.map(issue => ({
        row: row.rowNumber,
        status: t(`dataImport:statuses.${row.status}`),
        sku: row.normalized.sku,
        field: t(`dataImport:fields.${issue.field}`),
        issue: t(`dataImport:issues.${issue.code}`),
      }))
    );
    return rows;
  };
  const handleDownloadIssues = () => {
    const columns: ExportColumn<IssueExportRow>[] = [
      {
        key: 'row',
        header: t('dataImport:table.row'),
      },
      {
        key: 'status',
        header: t('dataImport:table.status'),
      },
      {
        key: 'sku',
        header: t('dataImport:fields.sku'),
      },
      {
        key: 'field',
        header: t('dataImport:table.field'),
      },
      {
        key: 'issue',
        header: t('dataImport:table.issues'),
      },
    ];
    exportToCSV(buildIssueRows(), columns, 'puntovivo-launch-import-issues', {
      includeTimestamp: true,
    });
  };
  const handleDownloadReport = () => {
    if (!preview || !report) return;
    const rows: Array<IssueExportRow & ReportExportRow> = buildProductImportReportRows(
      preview,
      report
    ).map(row => ({
      row: row.rowNumber,
      status: t(`dataImport:report.statuses.${row.status}`),
      sku: row.sku,
      productId: row.productId,
      stockInitialized:
        row.stockInitialized === null
          ? ''
          : t(`dataImport:report.boolean.${row.stockInitialized ? 'yes' : 'no'}`),
      field: row.issue ? t(`dataImport:fields.${row.issue.field}`) : '',
      issue: row.issue ? t(`dataImport:issues.${row.issue.code}`) : '',
    }));
    const columns: ExportColumn<IssueExportRow & ReportExportRow>[] = [
      {
        key: 'row',
        header: t('dataImport:table.row'),
      },
      {
        key: 'status',
        header: t('dataImport:table.status'),
      },
      {
        key: 'sku',
        header: t('dataImport:fields.sku'),
      },
      {
        key: 'productId',
        header: t('dataImport:report.productId'),
      },
      {
        key: 'stockInitialized',
        header: t('dataImport:report.stockRecorded'),
      },
      {
        key: 'field',
        header: t('dataImport:table.field'),
      },
      {
        key: 'issue',
        header: t('dataImport:table.issues'),
      },
    ];
    const firstImportId = report.importId.split(', ')[0];
    exportToCSV(rows, columns, `puntovivo-launch-import-${firstImportId}`, {
      includeTimestamp: true,
    });
  };
  const handleDownloadTemplate = () => {
    const columns: ExportColumn<Record<string, string>>[] = TEMPLATE_KEYS.map(key => ({
      key,
      header: t(`dataImport:fields.${key}`),
    }));
    exportToCSV(
      [
        {
          name: t('dataImport:template.sampleName'),
          sku: 'SKU-001',
          description: t('dataImport:template.sampleDescription'),
          barcode: '7701234567890',
          price: '12500',
          cost: '8000',
          unit: 'UND',
          stock: '24',
          minStock: '5',
          taxName: 'IVA 19%',
          taxRate: '19',
          tracksStock: t('dataImport:boolean.yes'),
          tracksLots: t('dataImport:boolean.no'),
        },
      ],
      columns,
      'puntovivo-products-template',
      {
        includeTimestamp: false,
      }
    );
  };
  const handleReset = () => {
    if (isBusy) return;
    clearSource();
    setImportMode('create');
    setSkuPrefix('');
    setDefaultTaxRate('');
    setFileError(null);
    invalidatePreview();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const canPreview = Boolean(file && mapping && hasRequiredProductMapping(mapping, requireCost));
  const batchLabel = (phase: BatchProgress['phase']) =>
    progress?.phase === phase && progress.total > 1
      ? t(
          phase === 'preview'
            ? 'dataImport:actions.previewingBatch'
            : 'dataImport:actions.importingBatch',
          {
            done: Math.min(progress.done + 1, progress.total),
            total: progress.total,
          }
        )
      : undefined;
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button type="button" onClick={handleDownloadTemplate} variant="outline">
          <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
          {t('dataImport:actions.downloadTemplate')}
        </Button>
      </div>

      <ImportSourcePanel
        file={file}
        fileError={fileError}
        inputRef={fileInputRef}
        isBusy={isBusy}
        isParsing={isParsing}
        onFile={selected => void handleFile(selected)}
        onReset={handleReset}
        accept={PRODUCT_FILE_ACCEPT}
        descriptionKey="steps.upload.productDescription"
      />

      {workbook ? (
        <ProductImportSourcePanel
          workbook={workbook}
          sheetIndex={sheetIndex}
          headerIndex={headerIndex}
          importMode={importMode}
          skuPrefix={skuPrefix}
          defaultTaxRate={defaultTaxRate}
          disabled={isBusy}
          onSheetChange={value => {
            const sheet = workbook.sheets[value];
            const header = sheet ? detectProductHeaderIndex(sheet) : 0;
            applySource(workbook, value, header, importMode);
          }}
          onHeaderChange={value => applySource(workbook, sheetIndex, value, importMode)}
          onImportModeChange={value => {
            setImportMode(value);
            invalidatePreview();
            if (file) remap(file.headers, value);
          }}
          onSkuPrefixChange={value => {
            setSkuPrefix(value);
            invalidatePreview();
          }}
          onDefaultTaxRateChange={value => {
            setDefaultTaxRate(value);
            invalidatePreview();
          }}
        />
      ) : null}

      {file && mapping ? (
        <>
          <ProductImportMappingPanel
            headers={file.headers}
            mapping={mapping}
            decimalFormat={decimalFormat}
            profileId={profileId}
            detectedProfileId={detectedProfileId}
            importMode={importMode}
            costCandidates={costCandidates}
            disabled={isBusy}
            onMappingChange={(field: ProductImportField, source: string) => {
              setMapping(current =>
                current
                  ? {
                      ...current,
                      [field]: source,
                    }
                  : current
              );
              invalidatePreview();
            }}
            onDecimalFormatChange={value => {
              setDecimalFormat(value);
              invalidatePreview();
            }}
            onProfileChange={value => {
              setProfileId(value);
              setMapping(buildProductImportProfileMapping(file.headers, value));
              invalidatePreview();
            }}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={!canPreview || isBusy}
              onClick={() => void handlePreview()}
              variant="primary"
            >
              {previewMutation.isPending || progress?.phase === 'preview' ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {batchLabel('preview') ?? t('dataImport:actions.preview')}
            </Button>
          </div>
        </>
      ) : null}

      {preview ? (
        <ProductImportPreviewPanel
          preview={preview}
          confirmedRealData={confirmedRealData}
          dataMode={dataMode}
          importing={importMutation.isPending || progress?.phase === 'import'}
          importingLabel={batchLabel('import')}
          completed={Boolean(report)}
          onImport={() => void handleImport()}
          onDownloadIssues={handleDownloadIssues}
          onConfirmRealData={setConfirmedRealData}
        />
      ) : null}

      {report ? (
        <ProductImportReportPanel
          report={report}
          importMode={importMode}
          onDownloadReport={handleDownloadReport}
        />
      ) : null}
    </div>
  );
}
