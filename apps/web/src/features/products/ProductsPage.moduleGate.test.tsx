/**
 * Products semantic-search module gate.
 *
 * The server now rejects `products.semanticSearch` when the
 * `semantic-search` module is inactive. ProductsPage must hide the
 * semantic toolbar and keep the query disabled in that state.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  useAuthMock,
  useIsModuleActiveMock,
  useModulesSnapshotMock,
  semanticSearchUseQueryMock,
  embeddingHealthUseQueryMock,
  regenerateMutateMock,
  semanticSearchInvalidateMock,
  embeddingHealthInvalidateMock,
  regenerateResultMock,
  marginUseQueryMock,
  productsListUseQueryMock,
  productsListFetchMock,
  exportToExcelMock,
  toastWarningMock,
} = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useIsModuleActiveMock: vi.fn(),
  useModulesSnapshotMock: vi.fn(),
  semanticSearchUseQueryMock: vi.fn(),
  embeddingHealthUseQueryMock: vi.fn(),
  regenerateMutateMock: vi.fn(),
  semanticSearchInvalidateMock: vi.fn(),
  embeddingHealthInvalidateMock: vi.fn(),
  regenerateResultMock: vi.fn(),
  marginUseQueryMock: vi.fn(),
  productsListUseQueryMock: vi.fn(),
  productsListFetchMock: vi.fn(),
  exportToExcelMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('@/services/export/exportService', () => ({ exportToExcel: exportToExcelMock }));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: useAuthMock,
}));

vi.mock('@/features/modules', () => ({
  useIsModuleActive: useIsModuleActiveMock,
  useModulesSnapshot: useModulesSnapshotMock,
}));

vi.mock('@/components/feedback/ToastProvider', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: toastWarningMock,
  }),
}));

vi.mock('@/components/tables/DataTable', () => ({
  DataTable: ({
    searchPlaceholder,
    searchValue,
    onSearchChange,
  }: {
    searchPlaceholder?: string;
    searchValue?: string;
    onSearchChange?: (value: string) => void;
  }) =>
    searchValue !== undefined ? (
      <input
        data-testid="products-table-search"
        aria-label={searchPlaceholder}
        value={searchValue}
        onChange={event => onSearchChange?.(event.target.value)}
      />
    ) : null,
}));

vi.mock('@/components/tables/TableExportActions', () => ({
  TableExportActions: () => <div data-testid="export-actions" />,
}));

vi.mock('@/features/products/ProductFormModal', () => ({
  ProductFormModal: () => null,
}));

vi.mock('@/components/form-controls/Modal', () => ({
  Modal: () => null,
  ConfirmModal: () => null,
}));

vi.mock('@/lib/trpc', async () => ({
  ...(await vi.importActual<typeof import('@/lib/trpc')>('@/lib/trpc')),
  trpc: {
    useUtils: () => ({
      products: {
        list: { invalidate: vi.fn(), fetch: productsListFetchMock },
        semanticSearch: { invalidate: semanticSearchInvalidateMock },
        embeddingHealth: { invalidate: embeddingHealthInvalidateMock },
        getById: { invalidate: vi.fn() },
        getVariantMatrix: { invalidate: vi.fn() },
      },
    }),
    products: {
      list: {
        useQuery: (input: unknown) => productsListUseQueryMock(input),
      },
      semanticSearch: {
        useQuery: semanticSearchUseQueryMock,
      },
      embeddingHealth: {
        useQuery: embeddingHealthUseQueryMock,
      },
      regenerateEmbeddings: {
        useMutation: (options?: {
          onSuccess?: (data: { ok: boolean; embedded: number }) => void;
        }) => ({
          mutate: () => {
            regenerateMutateMock();
            options?.onSuccess?.(regenerateResultMock());
          },
          isPending: false,
        }),
      },
      getById: {
        useQuery: () => ({ data: null }),
      },
      getVariantMatrix: {
        useQuery: () => ({ data: null, isLoading: false, error: null }),
      },
      create: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      update: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      delete: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      createVariantMatrix: {
        useMutation: () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
      },
    },
    // the margin query is admin-only; the page keeps a stable
    // empty column while an enabled query loads.
    reports: {
      profit: { margin: { useQuery: marginUseQueryMock } },
    },
    categories: {
      tree: {
        useQuery: () => ({ data: { items: [] } }),
      },
    },
    providers: {
      list: {
        useQuery: () => ({ data: { items: [] } }),
      },
    },
    locations: {
      list: {
        useQuery: () => ({ data: { items: [] } }),
      },
    },
    units: {
      list: {
        useQuery: () => ({ data: { items: [] } }),
      },
    },
    vatRates: {
      list: {
        useQuery: () => ({ data: { items: [] } }),
      },
    },
  },
}));

import { ProductsPage } from './ProductsPage';

describe('ProductsPage semantic-search module gate', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
    useIsModuleActiveMock.mockReset();
    semanticSearchUseQueryMock.mockReset();
    embeddingHealthUseQueryMock.mockReset();
    useModulesSnapshotMock.mockReset();
    regenerateMutateMock.mockReset();
    semanticSearchInvalidateMock.mockReset();
    embeddingHealthInvalidateMock.mockReset();
    regenerateResultMock.mockReset();
    marginUseQueryMock.mockReset();
    productsListUseQueryMock.mockReset();
    productsListFetchMock.mockReset();
    exportToExcelMock.mockReset();
    toastWarningMock.mockReset();
    useAuthMock.mockReturnValue({
      user: { id: 'u-1', role: 'manager' },
    });
    semanticSearchUseQueryMock.mockReturnValue({
      data: null,
      isFetching: false,
    });
    embeddingHealthUseQueryMock.mockReturnValue({ data: null, isLoading: false });
    marginUseQueryMock.mockReturnValue({ data: null, isLoading: false, error: null });
    productsListUseQueryMock.mockReturnValue({
      data: { items: [] },
      isLoading: false,
      error: null,
    });
    regenerateResultMock.mockReturnValue({ ok: true, embedded: 3 });
    useModulesSnapshotMock.mockReturnValue({
      modules: { 'semantic-search': true },
      isLoading: false,
      isPlaceholder: false,
    });
  });

  it('only enables the realized-margin query for admins', () => {
    useIsModuleActiveMock.mockReturnValue(false);
    render(<ProductsPage />);
    expect(marginUseQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 500 }),
      expect.objectContaining({ enabled: false })
    );

    marginUseQueryMock.mockClear();
    useAuthMock.mockReturnValue({ user: { id: 'u-admin', role: 'admin' } });
    render(<ProductsPage />);
    expect(marginUseQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 500 }),
      expect.objectContaining({ enabled: true, staleTime: 5 * 60_000 })
    );
  });

  it('hides the semantic toolbar and disables the query when module is inactive', () => {
    useIsModuleActiveMock.mockReturnValue(false);

    render(<ProductsPage />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(semanticSearchUseQueryMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ enabled: false })
    );
    expect(embeddingHealthUseQueryMock).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false })
    );
  });

  it('debounces literal search into the server query instead of filtering one loaded page', async () => {
    useIsModuleActiveMock.mockReturnValue(false);

    render(<ProductsPage />);
    fireEvent.change(screen.getByTestId('products-table-search'), {
      target: { value: 'product beyond first page' },
    });

    await waitFor(() => {
      expect(productsListUseQueryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'product beyond first page' })
      );
    });
  });

  it('combines SKU prefix and status filters and paginates server results', async () => {
    useIsModuleActiveMock.mockReturnValue(false);
    productsListUseQueryMock.mockReturnValue({
      data: { items: [{ id: 'p1', name: 'Fox', sku: 'fox-1' }], totalItems: 21, totalPages: 2 },
      isLoading: false,
      error: null,
    });
    render(<ProductsPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'SKU starts with' }), {
      target: { value: 'fox-' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'active' },
    });
    await waitFor(() =>
      expect(productsListUseQueryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ skuPrefix: 'fox-', isActive: true, page: 1 })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(productsListUseQueryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ skuPrefix: 'fox-', isActive: true, page: 2 })
    );
  });

  it('exports every filtered page, not just the visible products', async () => {
    useIsModuleActiveMock.mockReturnValue(false);
    productsListUseQueryMock.mockReturnValue({
      data: { items: [{ id: 'p1', name: 'Fox', sku: 'fox-1' }], totalItems: 2, totalPages: 1 },
      isLoading: false,
      error: null,
    });
    productsListFetchMock.mockImplementation(async ({ page }: { page: number }) => ({
      items: [{ id: `p${page}`, name: 'Fox', sku: `fox-${page}` }],
      totalItems: 2,
      totalPages: 2,
    }));
    render(<ProductsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all 2 results to Excel' }));
    await waitFor(() =>
      expect(exportToExcelMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'p1' }),
          expect.objectContaining({ id: 'p2' }),
        ]),
        expect.any(Array),
        'products-editable',
        expect.any(Object)
      )
    );
    expect(productsListFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ perPage: 200, page: 2 })
    );
  });

  it('exports only selected product IDs after fetching the whole filtered catalog', async () => {
    useIsModuleActiveMock.mockReturnValue(false);
    productsListUseQueryMock.mockReturnValue({
      data: { items: [{ id: 'p1', name: 'Fox', sku: 'fox-1' }], totalItems: 2, totalPages: 2 },
      isLoading: false,
      error: null,
    });
    productsListFetchMock.mockImplementation(async ({ page }: { page: number }) => ({
      items: [{ id: `p${page}`, name: 'Fox', sku: `fox-${page}` }],
      totalItems: 2,
      totalPages: 2,
    }));
    render(<ProductsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Select or deselect this page' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export selected to Excel' }));
    await waitFor(() =>
      expect(exportToExcelMock).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'p1' })],
        expect.any(Array),
        'products-editable',
        expect.any(Object)
      )
    );
  });

  it('keeps semantic queries disabled while the modules snapshot is still placeholder', () => {
    useIsModuleActiveMock.mockReturnValue(true);
    useModulesSnapshotMock.mockReturnValue({
      modules: { 'semantic-search': true },
      isLoading: true,
      isPlaceholder: true,
    });

    render(<ProductsPage />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(semanticSearchUseQueryMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ enabled: false })
    );
    expect(embeddingHealthUseQueryMock).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false })
    );
  });

  it('shows the semantic toolbar when module is active for manager+', () => {
    useIsModuleActiveMock.mockReturnValue(true);

    render(<ProductsPage />);

    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate|regenerar/i })).not.toBeInTheDocument();
  });

  it('reveals the semantic search input after the active module switch is enabled', () => {
    useIsModuleActiveMock.mockReturnValue(true);

    render(<ProductsPage />);
    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(semanticSearchUseQueryMock).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ enabled: false })
    );
  });

  it('keeps regenerate embeddings available only to admins when module is active', async () => {
    useAuthMock.mockReturnValue({
      user: { id: 'u-1', role: 'admin' },
    });
    useIsModuleActiveMock.mockReturnValue(true);

    render(<ProductsPage />);
    fireEvent.click(screen.getByRole('button', { name: /regenerate|regenerar/i }));

    expect(regenerateMutateMock).toHaveBeenCalled();
    await waitFor(() => {
      expect(semanticSearchInvalidateMock).toHaveBeenCalled();
      expect(embeddingHealthInvalidateMock).toHaveBeenCalled();
    });
  });

  it('uses provider-neutral recovery copy when regeneration is unavailable', async () => {
    useAuthMock.mockReturnValue({
      user: { id: 'u-1', role: 'admin' },
    });
    useIsModuleActiveMock.mockReturnValue(true);
    regenerateResultMock.mockReturnValue({ ok: false, embedded: 0 });

    render(<ProductsPage />);
    fireEvent.click(screen.getByRole('button', { name: /regenerate|regenerar/i }));

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalledWith({
        title:
          'Cannot regenerate: enable AI in Company settings and make sure the selected provider is available.',
      });
    });
    expect(semanticSearchInvalidateMock).not.toHaveBeenCalled();
    expect(embeddingHealthInvalidateMock).not.toHaveBeenCalled();
  });
});
