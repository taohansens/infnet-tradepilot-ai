/**
 * Tipos e ações obrigatórias da Trilha de Auditoria Transacional Imutável (Append-Only).
 *
 * @spec SPEC-04
 * @rnf RNF-15
 * @rnf RNF-30
 */

export const AUDIT_ACTIONS = [
  'TRADE_MANUAL_CREATE',
  'TRADE_EDIT',
  'TRADE_DELETE',
  'CONCILIATION_MERGE',
  'FISCAL_PRIOR_LOSS_SET',
  'DATA_EXPORT',
  'ACCOUNT_DELETE',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  'USER',
  'TRADE',
  'INGESTION_JOB',
  'STAGING_ITEM',
  'FISCAL_ADJUSTMENT',
  'PRIVACY_EXPORT',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Representação serializável (JSON-safe) de um snapshot de auditoria.
 * Valores monetários devem ser serializados como string decimal exata (ex.: "1500.0000"),
 * nunca como float binário sem precisão.
 *
 * @spec SPEC-04
 * @rnf RNF-30
 */
export type AuditSnapshot = Record<string, unknown> | null;
