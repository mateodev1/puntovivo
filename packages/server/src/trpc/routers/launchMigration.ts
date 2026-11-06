/** -123b — Admin-only launch-migration workbench transport. */
import {
  commitLaunchCustomerBalanceImport,
  commitLaunchCustomerImport,
  commitLaunchProductImport,
  commitLaunchProviderImport,
  commitLaunchOpeningCashImport,
  previewLaunchCustomerBalanceImport,
  previewLaunchCustomerImport,
  previewLaunchProductImport,
  previewLaunchProviderImport,
  previewLaunchOpeningCashImport,
  commitLaunchFiscalProfileImport,
  previewLaunchFiscalProfileImport,
} from '../../application/launch-migration/index.js';
import { router } from '../init.js';
import { passwordSessionRequired } from '../middleware/passwordSession.js';
import { adminProcedure } from '../middleware/roles.js';
import {
  commitLaunchCustomerBalanceImportInput,
  commitLaunchCustomerImportInput,
  commitLaunchProductImportInput,
  commitLaunchProviderImportInput,
  commitLaunchOpeningCashImportInput,
  previewLaunchCustomerBalanceImportInput,
  previewLaunchCustomerImportInput,
  previewLaunchProductImportInput,
  previewLaunchProviderImportInput,
  previewLaunchOpeningCashImportInput,
  commitLaunchFiscalProfileImportInput,
  previewLaunchFiscalProfileImportInput,
} from '../schemas/launchMigration.js';

export const launchMigrationRouter = router({
  previewProducts: adminProcedure
    .input(previewLaunchProductImportInput)
    .mutation(({ ctx, input }) => previewLaunchProductImport({ ...ctx, user: ctx.user! }, input)),
  importProducts: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchProductImportInput)
    .mutation(({ ctx, input }) => commitLaunchProductImport({ ...ctx, user: ctx.user! }, input)),
  previewCustomers: adminProcedure
    .input(previewLaunchCustomerImportInput)
    .mutation(({ ctx, input }) => previewLaunchCustomerImport({ ...ctx, user: ctx.user! }, input)),
  importCustomers: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchCustomerImportInput)
    .mutation(({ ctx, input }) => commitLaunchCustomerImport({ ...ctx, user: ctx.user! }, input)),
  previewProviders: adminProcedure
    .input(previewLaunchProviderImportInput)
    .mutation(({ ctx, input }) => previewLaunchProviderImport({ ...ctx, user: ctx.user! }, input)),
  importProviders: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchProviderImportInput)
    .mutation(({ ctx, input }) => commitLaunchProviderImport({ ...ctx, user: ctx.user! }, input)),
  previewCustomerBalances: adminProcedure
    .input(previewLaunchCustomerBalanceImportInput)
    .mutation(({ ctx, input }) =>
      previewLaunchCustomerBalanceImport({ ...ctx, user: ctx.user! }, input)
    ),
  importCustomerBalances: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchCustomerBalanceImportInput)
    .mutation(({ ctx, input }) =>
      commitLaunchCustomerBalanceImport({ ...ctx, user: ctx.user! }, input)
    ),
  previewOpeningCash: adminProcedure
    .input(previewLaunchOpeningCashImportInput)
    .mutation(({ ctx, input }) =>
      previewLaunchOpeningCashImport({ ...ctx, user: ctx.user! }, input)
    ),
  importOpeningCash: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchOpeningCashImportInput)
    .mutation(({ ctx, input }) =>
      commitLaunchOpeningCashImport({ ...ctx, user: ctx.user! }, input)
    ),
  previewFiscalProfiles: adminProcedure
    .input(previewLaunchFiscalProfileImportInput)
    .mutation(({ ctx, input }) =>
      previewLaunchFiscalProfileImport({ ...ctx, user: ctx.user! }, input)
    ),
  importFiscalProfiles: adminProcedure
    .use(passwordSessionRequired)
    .input(commitLaunchFiscalProfileImportInput)
    .mutation(({ ctx, input }) =>
      commitLaunchFiscalProfileImport({ ...ctx, user: ctx.user! }, input)
    ),
});
