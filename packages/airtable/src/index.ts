export { AirtableClient, type AirtableClientOptions, type AirtableFields } from './client';
export {
  runAirtableSync,
  SYNC_TABLES,
  type SyncOptions,
  type SyncReport,
  type SyncTableConfig,
} from './sync';
export {
  AirtableMetaClient,
  AirtableScopeError,
  BASE_SCHEMA,
  ensureBaseSchema,
  expectedColumns,
  missingFromBase,
  parseBaseId,
  type AirtableBaseSummary,
  type AirtableMetaClientOptions,
  type FieldSpec,
  type LinkSpec,
  type SetupReport,
  type TableSpec,
} from './schema';
export * from './mapping';
