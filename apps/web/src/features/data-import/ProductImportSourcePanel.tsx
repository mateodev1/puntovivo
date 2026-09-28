import { useTranslation } from 'react-i18next';
import { HEADER_SCAN_ROWS, type ImportWorkbook } from './fileParser';
import { PRODUCT_IMPORT_MODES, type ProductImportMode } from './productImportSource';

interface ProductImportSourcePanelProps {
  workbook: ImportWorkbook;
  sheetIndex: number;
  headerIndex: number;
  importMode: ProductImportMode;
  skuPrefix: string;
  defaultTaxRate: string;
  disabled: boolean;
  onSheetChange: (sheetIndex: number) => void;
  onHeaderChange: (headerIndex: number) => void;
  onImportModeChange: (mode: ProductImportMode) => void;
  onSkuPrefixChange: (value: string) => void;
  onDefaultTaxRateChange: (value: string) => void;
}

function rowPreview(cells: string[]): string {
  const text = cells
    .map(cell => cell.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

export function ProductImportSourcePanel({
  workbook,
  sheetIndex,
  headerIndex,
  importMode,
  skuPrefix,
  defaultTaxRate,
  disabled,
  onSheetChange,
  onHeaderChange,
  onImportModeChange,
  onSkuPrefixChange,
  onDefaultTaxRateChange,
}: ProductImportSourcePanelProps) {
  const { t } = useTranslation('dataImport');
  const sheet = workbook.sheets[sheetIndex];
  const headerOptions = sheet ? sheet.cells.slice(0, HEADER_SCAN_ROWS) : [];

  return (
    <section
      className="card space-y-5 p-6"
      aria-labelledby="data-import-source-options-title"
      data-testid="data-import-source-options"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
          {t('source.kicker')}
        </p>
        <h2
          id="data-import-source-options-title"
          className="mt-1 text-lg font-semibold text-secondary-900"
        >
          {t('source.title')}
        </h2>
        <p className="mt-1 text-sm text-secondary-600">{t('source.description')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {workbook.sheets.length > 1 ? (
          <div>
            <label htmlFor="data-import-sheet" className="label mb-2 block">
              {t('source.sheet')}
            </label>
            <select
              id="data-import-sheet"
              value={sheetIndex}
              disabled={disabled}
              onChange={event => onSheetChange(Number(event.target.value))}
              className="input w-full"
            >
              {workbook.sheets.map((candidate, index) => {
                const name = candidate.hidden
                  ? t('source.hiddenSheet', { name: candidate.name })
                  : candidate.name;
                return (
                  <option key={`${index}:${candidate.name}`} value={index}>
                    {t('source.sheetRows', { name, count: candidate.cells.length })}
                  </option>
                );
              })}
            </select>
          </div>
        ) : null}

        <div>
          <label htmlFor="data-import-header-row" className="label mb-2 block">
            {t('source.headerRow')}
          </label>
          <select
            id="data-import-header-row"
            value={headerIndex}
            disabled={disabled || headerOptions.length === 0}
            onChange={event => onHeaderChange(Number(event.target.value))}
            className="input w-full"
          >
            {headerOptions.map((cells, index) => (
              <option key={sheet!.rowNumbers[index]} value={index}>
                {t('source.headerRowOption', {
                  row: sheet!.rowNumbers[index],
                  preview: rowPreview(cells),
                })}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="label mb-2 block">{t('source.importMode')}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {PRODUCT_IMPORT_MODES.map(mode => (
            <label
              key={mode}
              className={
                importMode === mode
                  ? 'flex cursor-pointer gap-3 rounded-lg border border-primary-300 bg-primary-50 p-3'
                  : 'flex cursor-pointer gap-3 rounded-lg border border-line p-3 hover:bg-secondary-50'
              }
            >
              <input
                type="radio"
                name="data-import-product-mode"
                value={mode}
                checked={importMode === mode}
                disabled={disabled}
                onChange={() => onImportModeChange(mode)}
                className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500"
              />
              <span>
                <span className="block text-sm font-semibold text-secondary-900">
                  {t(`source.modes.${mode}.label`)}
                </span>
                <span className="mt-1 block text-xs text-secondary-600">
                  {t(`source.modes.${mode}.description`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="data-import-sku-prefix" className="label mb-2 block">
            {t('source.skuPrefix')}
          </label>
          <input
            id="data-import-sku-prefix"
            type="text"
            value={skuPrefix}
            maxLength={20}
            disabled={disabled}
            placeholder={t('source.skuPrefixPlaceholder')}
            onChange={event => onSkuPrefixChange(event.target.value)}
            className="input w-full"
            aria-describedby="data-import-sku-prefix-help"
          />
          <p id="data-import-sku-prefix-help" className="mt-1 text-xs text-secondary-500">
            {t('source.skuPrefixHelp')}
          </p>
        </div>
        <div>
          <label htmlFor="data-import-default-tax" className="label mb-2 block">
            {t('source.defaultTaxRate')}
          </label>
          <input
            id="data-import-default-tax"
            type="text"
            inputMode="decimal"
            value={defaultTaxRate}
            maxLength={8}
            disabled={disabled}
            placeholder={t('source.defaultTaxRatePlaceholder')}
            onChange={event => onDefaultTaxRateChange(event.target.value)}
            className="input w-full"
            aria-describedby="data-import-default-tax-help"
          />
          <p id="data-import-default-tax-help" className="mt-1 text-xs text-secondary-500">
            {t('source.defaultTaxRateHelp')}
          </p>
        </div>
      </div>
    </section>
  );
}
