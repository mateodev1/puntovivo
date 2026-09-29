import { useTranslation } from 'react-i18next';

import {
  PRODUCT_IMPORT_FIELDS,
  type ProductImportField,
  type ProductImportMapping,
} from './productImportMapping';
import type { ImportDecimalFormat } from './types';
import {
  PRODUCT_IMPORT_PROFILE_IDS,
  matchesProductImportProfileSignature,
  type ProductImportProfileId,
} from './productImportProfiles';
import type { ProductImportMode } from './productImportSource';

interface ProductImportMappingPanelProps {
  headers: string[];
  mapping: ProductImportMapping;
  decimalFormat: ImportDecimalFormat;
  profileId: ProductImportProfileId;
  detectedProfileId: ProductImportProfileId;
  importMode?: ProductImportMode;
  /** Price-like source columns; more than one means the operator must pick the cost. */
  costCandidates?: string[];
  disabled: boolean;
  onMappingChange: (field: ProductImportField, sourceHeader: string) => void;
  onDecimalFormatChange: (format: ImportDecimalFormat) => void;
  onProfileChange: (profileId: ProductImportProfileId) => void;
}

export function ProductImportMappingPanel({
  headers,
  mapping,
  decimalFormat,
  profileId,
  detectedProfileId,
  importMode = 'create',
  costCandidates = [],
  disabled,
  onMappingChange,
  onDecimalFormatChange,
  onProfileChange,
}: ProductImportMappingPanelProps) {
  const { t } = useTranslation('dataImport');

  return (
    <section className="card space-y-5 p-6" aria-labelledby="data-import-mapping-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
          {t('steps.map.kicker')}
        </p>
        <h2
          id="data-import-mapping-title"
          className="mt-1 text-lg font-semibold text-secondary-900"
        >
          {t('steps.map.title')}
        </h2>
        <p className="mt-1 text-sm text-secondary-600">{t('steps.map.description')}</p>
      </div>

      {importMode === 'upsert' ? (
        <div className="space-y-2 rounded-xl border border-primary-100 bg-primary-50/60 p-4">
          <p className="text-xs font-medium leading-5 text-secondary-800">
            {t(mapping.productId ? 'steps.map.catalogNote' : 'steps.map.upsertNote')}
          </p>
          {!mapping.productId && !mapping.cost && costCandidates.length > 1 ? (
            <p
              className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs font-semibold text-warning-900"
              data-testid="data-import-cost-candidates"
            >
              {t('steps.map.costCandidates', { columns: costCandidates.join(', ') })}
            </p>
          ) : !mapping.productId && !mapping.cost ? (
            <p className="text-xs font-semibold text-warning-900">{t('steps.map.costRequired')}</p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-xl border border-primary-100 bg-primary-50/60 p-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div>
              <label htmlFor="data-import-source-profile" className="label mb-2 block">
                {t('profiles.label')}
              </label>
              <select
                id="data-import-source-profile"
                value={profileId}
                disabled={disabled}
                onChange={event => onProfileChange(event.target.value as ProductImportProfileId)}
                className="input w-full"
              >
                {PRODUCT_IMPORT_PROFILE_IDS.map(id => (
                  <option key={id} value={id}>
                    {t(`profiles.options.${id}`)}
                  </option>
                ))}
              </select>
            </div>
            <span className="inline-flex w-fit rounded-full border border-primary-200 bg-white px-3 py-1.5 text-xs font-semibold text-primary-800">
              {profileId !== 'generic' &&
              matchesProductImportProfileSignature(headers, profileId) &&
              profileId === detectedProfileId
                ? t('profiles.detected')
                : t('profiles.reviewRequired')}
            </span>
          </div>
          <p className="mt-3 text-xs font-medium leading-5 text-secondary-800">
            {t(`profiles.details.${profileId}`)}
          </p>
          <p className="mt-3 text-xs leading-5 text-secondary-600">{t('profiles.boundary')}</p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {PRODUCT_IMPORT_FIELDS.map(field => {
          const id = `data-import-map-${field}`;
          const required =
            !mapping.productId &&
            (field === 'name' || field === 'sku' || (importMode === 'upsert' && field === 'cost'));
          return (
            <div key={field}>
              <label htmlFor={id} className="label mb-2 block">
                {t(`fields.${field}`)}
                {required ? <span className="ml-1 text-danger-700">*</span> : null}
              </label>
              <select
                id={id}
                value={mapping[field]}
                disabled={disabled}
                aria-required={required}
                onChange={event => onMappingChange(field, event.target.value)}
                className="input w-full"
              >
                <option value="">{t('steps.map.notMapped')}</option>
                {headers.map(header => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="max-w-sm">
        <label htmlFor="data-import-decimal-format" className="label mb-2 block">
          {t('steps.map.decimalFormat')}
        </label>
        <select
          id="data-import-decimal-format"
          value={decimalFormat}
          disabled={disabled}
          onChange={event => onDecimalFormatChange(event.target.value as ImportDecimalFormat)}
          className="input w-full"
        >
          <option value="auto">{t('decimalFormats.auto')}</option>
          <option value="comma">{t('decimalFormats.comma')}</option>
          <option value="dot">{t('decimalFormats.dot')}</option>
        </select>
      </div>
    </section>
  );
}
