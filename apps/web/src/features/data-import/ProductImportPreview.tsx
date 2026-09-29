import { AlertTriangle, CheckCircle2, Copy, MinusCircle, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ImportCommitGuard } from './ImportCommitGuard';
import type {
  LaunchImportDataMode,
  ProductImportIssue,
  ProductImportPreview,
  ProductImportPreviewRow,
} from './types';
import { Button } from '@/components/ui';
interface ProductImportPreviewProps {
  preview: ProductImportPreview;
  confirmedRealData: boolean;
  dataMode: LaunchImportDataMode;
  importing: boolean;
  /** Replaces the import button label while batches are running. */
  importingLabel?: string | undefined;
  completed: boolean;
  onImport: () => void;
  onDownloadIssues: () => void;
  onConfirmRealData: (confirmed: boolean) => void;
}
type PreviewStatus = ProductImportPreviewRow['status'];
const STATUS_STYLE: Record<PreviewStatus, string> = {
  ready: 'bg-success-50 text-success-800 border-success-200',
  update: 'bg-primary-50 text-primary-800 border-primary-200',
  unchanged: 'bg-secondary-50 text-secondary-700 border-secondary-200',
  duplicate: 'bg-warning-50 text-warning-800 border-warning-200',
  invalid: 'bg-danger-50 text-danger-800 border-danger-200',
};
const STATUS_ORDER: PreviewStatus[] = ['ready', 'update', 'unchanged', 'duplicate', 'invalid'];
const PREVIEW_ROW_LIMIT = 100;
function issueKey(issue: ProductImportIssue): string {
  return `issues.${issue.code}`;
}
export function ProductImportPreviewPanel({
  preview,
  confirmedRealData,
  dataMode,
  importing,
  importingLabel,
  completed,
  onImport,
  onDownloadIssues,
  onConfirmRealData,
}: ProductImportPreviewProps) {
  const { t, i18n } = useTranslation('dataImport');
  const [statusFilter, setStatusFilter] = useState<PreviewStatus | 'all'>('all');
  const upsert = preview.importMode === 'upsert';
  const hasIssues = preview.summary.duplicates + preview.summary.invalid > 0;
  const actionable = preview.summary.ready + preview.summary.updates;
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }),
    [i18n.language]
  );
  const percentFormat = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: 'percent',
        maximumFractionDigits: 1,
        signDisplay: 'exceptZero',
      }),
    [i18n.language]
  );
  const statusCounts = useMemo(() => {
    const counts = new Map<PreviewStatus, number>();
    for (const row of preview.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    return counts;
  }, [preview.rows]);
  const filteredRows = useMemo(
    () =>
      statusFilter === 'all'
        ? preview.rows
        : preview.rows.filter(row => row.status === statusFilter),
    [preview.rows, statusFilter]
  );
  const zeroPriceNewRows = upsert
    ? preview.rows.filter(row => row.status === 'ready' && row.normalized.price === 0).length
    : 0;

  const describeChange = (row: ProductImportPreviewRow): string => {
    if (row.status === 'ready') return t('table.newProduct');
    if (!row.existing || !row.changes || Object.keys(row.changes).length === 0) {
      return t('table.noChanges');
    }
    const parts: string[] = [];
    if (row.changes.name !== undefined)
      parts.push(t('table.nameChange', { from: row.existing.name, to: row.changes.name }));
    if (row.changes.sku !== undefined)
      parts.push(t('table.skuChange', { from: row.existing.sku, to: row.changes.sku }));
    if (row.changes.description !== undefined)
      parts.push(
        t('table.descriptionChange', {
          from: row.existing.description || t('table.emptyValue'),
          to: row.changes.description || t('table.emptyValue'),
        })
      );
    if (row.changes.cost !== undefined) {
      const from = row.existing.cost;
      parts.push(
        t('table.costChange', {
          from: numberFormat.format(from),
          to: numberFormat.format(row.changes.cost),
          percent:
            from === 0
              ? t('table.emptyValue')
              : percentFormat.format((row.changes.cost - from) / from),
        })
      );
    }
    if (row.changes.price !== undefined) {
      parts.push(
        t('table.priceChange', {
          from: numberFormat.format(row.existing.price),
          to: numberFormat.format(row.changes.price),
        })
      );
    }
    if (row.changes.taxRate !== undefined) {
      parts.push(
        t('table.taxChange', {
          from: numberFormat.format(row.existing.taxRate),
          to: numberFormat.format(row.changes.taxRate),
        })
      );
    }
    return parts.join(' · ');
  };

  const tiles = [
    ['total', preview.summary.total, Copy],
    ['ready', preview.summary.ready, CheckCircle2],
    ...(upsert
      ? ([
          ['updates', preview.summary.updates, RefreshCw],
          ['unchanged', preview.summary.unchanged, MinusCircle],
        ] as const)
      : []),
    ['duplicates', preview.summary.duplicates, Copy],
    ['invalid', preview.summary.invalid, AlertTriangle],
  ] as const;

  return (
    <section className="card space-y-5 p-6" aria-labelledby="data-import-preview-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
            {t('steps.preview.kicker')}
          </p>
          <h2
            id="data-import-preview-title"
            className="mt-1 text-lg font-semibold text-secondary-900"
          >
            {t('steps.preview.title')}
          </h2>
          <p className="mt-1 text-sm text-secondary-600">{t('steps.preview.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasIssues ? (
            <Button type="button" onClick={onDownloadIssues} variant="outline">
              {t('actions.downloadIssues')}
            </Button>
          ) : null}
          <ImportCommitGuard
            completed={completed}
            confirmed={confirmedRealData}
            dataMode={dataMode}
            importing={importing}
            importingLabel={importingLabel}
            readyLabel={upsert ? t('actions.importUpsert', { count: actionable }) : undefined}
            onConfirm={onConfirmRealData}
            onImport={onImport}
            ready={actionable}
          />
        </div>
      </div>

      <div
        className={cn('grid gap-3', upsert ? 'sm:grid-cols-3 xl:grid-cols-6' : 'sm:grid-cols-4')}
        aria-label={t('summary.ariaLabel')}
      >
        {tiles.map(([key, value, Icon]) => (
          <div key={key} className="metric-tile p-4" data-testid={`data-import-summary-${key}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-secondary-500">
                {t(`summary.${key}`)}
              </span>
              <Icon className="h-4 w-4 text-secondary-400" aria-hidden="true" />
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-secondary-900">{value}</p>
          </div>
        ))}
      </div>

      {zeroPriceNewRows > 0 ? (
        <p
          className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs font-medium text-warning-900"
          data-testid="data-import-zero-price-warning"
        >
          {t('preview.zeroPriceWarning', { count: zeroPriceNewRows })}
        </p>
      ) : null}

      {statusCounts.size > 1 ? (
        <div className="max-w-xs">
          <label htmlFor="data-import-preview-filter" className="label mb-2 block">
            {t('table.filter')}
          </label>
          <select
            id="data-import-preview-filter"
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as PreviewStatus | 'all')}
            className="input w-full"
          >
            <option value="all">{t('table.filterAll', { count: preview.rows.length })}</option>
            {STATUS_ORDER.filter(status => statusCounts.has(status)).map(status => (
              <option key={status} value={status}>
                {t('table.filterStatus', {
                  status: t(`statuses.${status}`),
                  count: statusCounts.get(status),
                })}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-secondary-50 text-xs uppercase tracking-wide text-secondary-600">
            <tr>
              <th className="px-4 py-3">{t('table.row')}</th>
              <th className="px-4 py-3">{t('fields.name')}</th>
              <th className="px-4 py-3">{t('fields.sku')}</th>
              {upsert ? (
                <>
                  <th className="px-4 py-3">{t('fields.cost')}</th>
                  <th className="px-4 py-3">{t('fields.taxRate')}</th>
                  <th className="px-4 py-3">{t('table.change')}</th>
                </>
              ) : (
                <>
                  <th className="px-4 py-3">{t('fields.price')}</th>
                  <th className="px-4 py-3">{t('fields.stock')}</th>
                  <th className="px-4 py-3">{t('fields.tracksStock')}</th>
                  <th className="px-4 py-3">{t('fields.tracksLots')}</th>
                </>
              )}
              <th className="px-4 py-3">{t('table.status')}</th>
              <th className="px-4 py-3">{t('table.details')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-white">
            {filteredRows.slice(0, PREVIEW_ROW_LIMIT).map(row => (
              <tr key={row.rowNumber} data-testid={`data-import-preview-row-${row.rowNumber}`}>
                <td className="px-4 py-3 tabular-nums text-secondary-600">{row.rowNumber}</td>
                <td className="px-4 py-3 font-medium text-secondary-900">
                  {row.normalized.name || t('table.emptyValue')}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-secondary-700">
                  {row.normalized.sku || t('table.emptyValue')}
                </td>
                {upsert ? (
                  <>
                    <td className="px-4 py-3 tabular-nums text-secondary-700">
                      {numberFormat.format(row.normalized.cost)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-secondary-700">
                      {numberFormat.format(row.normalized.taxRate)}%
                    </td>
                    <td className="max-w-xs px-4 py-3 text-xs text-secondary-700">
                      {row.status === 'duplicate' || row.status === 'invalid'
                        ? t('table.emptyValue')
                        : describeChange(row)}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 tabular-nums text-secondary-700">
                      {row.normalized.price}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-secondary-700">
                      {row.normalized.stock}
                    </td>
                    <td className="px-4 py-3 text-secondary-700">
                      {t(row.normalized.tracksStock ? 'boolean.yes' : 'boolean.no')}
                    </td>
                    <td className="px-4 py-3 text-secondary-700">
                      {t(row.normalized.tracksLots ? 'boolean.yes' : 'boolean.no')}
                    </td>
                  </>
                )}
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2 py-1 text-xs font-semibold',
                      STATUS_STYLE[row.status]
                    )}
                  >
                    {t(`statuses.${row.status}`)}
                  </span>
                </td>
                <td className="max-w-xs px-4 py-3 text-xs text-secondary-600">
                  {row.issues.length === 0
                    ? t('table.noIssues')
                    : row.issues
                        .map(issue => `${t(`fields.${issue.field}`)}: ${t(issueKey(issue))}`)
                        .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredRows.length > PREVIEW_ROW_LIMIT ? (
        <p className="text-xs text-secondary-500">
          {statusFilter === 'all'
            ? t('table.previewLimit', { count: filteredRows.length })
            : t('table.filteredLimit', { count: filteredRows.length })}
        </p>
      ) : null}
    </section>
  );
}
