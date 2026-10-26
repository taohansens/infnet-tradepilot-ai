import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import {
  AUDIT_ACTIONS,
  toNumeric4String,
  type AuditAction,
  type AuditEntityType,
  type AuditSnapshot,
} from '@tradepilot/shared';
import { getRequiredRlsContext, isValidUuid } from '../db/rlsContext.js';
import {
  runInRlsTransaction,
  type RlsTransactionClient,
} from '../db/prismaRls.js';

/**
 * Entrada para gravação de evento imutável na tabela `audit_logs`.
 *
 * @spec SPEC-04
 * @rnf RNF-15
 * @rnf RNF-30
 */
export interface RecordAuditEventInput {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  beforeSnapshot?: AuditSnapshot;
  afterSnapshot?: AuditSnapshot;
  /** Sobrescrita opcional apenas para fluxos internos já autenticados; padrão vem do contexto RLS. */
  actorId?: string;
  userId?: string;
  requestId?: string;
  ipHash?: string;
}

export interface AuditLogRecord {
  id: string;
  userId: string | null;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeSnapshot: Prisma.JsonValue | null;
  afterSnapshot: Prisma.JsonValue | null;
  requestId: string | null;
  ipHash: string | null;
  createdAtUtc: Date;
}

export interface AuditLogRepository {
  auditLog: {
    create(args: {
      data: {
        userId: string;
        actorId: string;
        action: string;
        entityType: string;
        entityId: string;
        beforeSnapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull;
        afterSnapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull;
        requestId: string | null;
        ipHash: string | null;
      };
    }): Promise<AuditLogRecord>;
    findMany(args: {
      where?: {
        entityType?: string;
        entityId?: string;
        action?: string;
      };
      orderBy: { createdAtUtc: 'desc' };
      take: number;
    }): Promise<AuditLogRecord[]>;
  };
}

/**
 * Serializa recursivamente um snapshot para JSON seguro, convertendo valores
 * `Decimal` / `Prisma.Decimal` em strings decimais exatas de 4 casas (`NUMERIC(18,4)`)
 * e `Date` em ISO-8601 UTC — garantindo zero perda de precisão monetária.
 *
 * @spec SPEC-04
 * @rnf RNF-20
 * @rnf RNF-30
 */
export function sanitizeAuditSnapshot(
  value: unknown,
): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Decimal || value instanceof Prisma.Decimal) {
    return toNumeric4String(value.toString());
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditSnapshot(item));
  }

  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = sanitizeAuditSnapshot(entry);
    }
    return out;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  return String(value);
}

/**
 * Serviço estritamente APPEND-ONLY de Trilha de Auditoria Transacional.
 *
 * Por contrato de segurança e conformidade fiscal (`SPEC-04`, `RNF-30`), este
 * serviço expõe exclusivamente operações de criação (`recordAuditEvent`) e
 * consulta (`listAuditEvents`) — nunca `update` ou `delete`.
 *
 * @spec SPEC-04
 * @spec SPEC-03
 * @rnf RNF-11
 * @rnf RNF-15
 * @rnf RNF-30
 */
export class AuditService {
  /**
   * Grava um evento imutável em `audit_logs`.
   *
   * Quando `tx` é informado, a gravação ocorre na mesma transação PostgreSQL da
   * operação de negócio (ex.: criação/edição manual de trade ou ajuste fiscal),
   * garantindo atomicidade total (`RNF-9`, `SPEC-04`).
   *
   * @spec SPEC-04
   * @rnf RNF-11
   * @rnf RNF-15
   * @rnf RNF-30
   */
  public async recordAuditEvent(
    input: RecordAuditEventInput,
    tx?: RlsTransactionClient | AuditLogRepository,
  ): Promise<AuditLogRecord> {
    if (!AUDIT_ACTIONS.includes(input.action)) {
      throw new Error(`Ação de auditoria não suportada: "${input.action}".`);
    }

    if (!isValidUuid(input.entityId)) {
      throw new Error(`entityId inválido para auditoria: "${input.entityId}".`);
    }

    const rlsCtx = tx ? undefined : getRequiredRlsContext();
    const userId = input.userId ?? rlsCtx?.userId;
    const actorId = input.actorId ?? userId;

    if (!userId || !isValidUuid(userId)) {
      throw new Error('userId válido é obrigatório para registrar evento em audit_logs.');
    }

    if (!actorId || !isValidUuid(actorId)) {
      throw new Error('actorId válido é obrigatório para registrar evento em audit_logs.');
    }

    const beforeSanitized = sanitizeAuditSnapshot(input.beforeSnapshot);
    const afterSanitized = sanitizeAuditSnapshot(input.afterSnapshot);

    const persist = async (repo: AuditLogRepository): Promise<AuditLogRecord> => {
      return repo.auditLog.create({
        data: {
          userId,
          actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          beforeSnapshot:
            beforeSanitized === null ? Prisma.JsonNull : beforeSanitized,
          afterSnapshot:
            afterSanitized === null ? Prisma.JsonNull : afterSanitized,
          requestId: input.requestId ?? rlsCtx?.requestId ?? null,
          ipHash: input.ipHash ?? rlsCtx?.ipHash ?? null,
        },
      });
    };

    if (tx) {
      return persist(tx as AuditLogRepository);
    }

    return runInRlsTransaction((rlsTx) => persist(rlsTx as unknown as AuditLogRepository));
  }

  /**
   * Consulta somente-leitura da trilha de auditoria do usuário autenticado.
   * O isolamento por `user_id` é reforçado pela política RLS `audit_logs_select_own`.
   *
   * @spec SPEC-04
   * @rnf RNF-11
   * @rnf RNF-30
   */
  public async listAuditEvents(
    filters: {
      entityType?: AuditEntityType;
      entityId?: string;
      action?: AuditAction;
      limit?: number;
    } = {},
    tx?: RlsTransactionClient | AuditLogRepository,
  ): Promise<AuditLogRecord[]> {
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const query = async (repo: AuditLogRepository): Promise<AuditLogRecord[]> => {
      return repo.auditLog.findMany({
        where: {
          entityType: filters.entityType,
          entityId: filters.entityId,
          action: filters.action,
        },
        orderBy: { createdAtUtc: 'desc' },
        take,
      });
    };

    if (tx) {
      return query(tx as AuditLogRepository);
    }

    return runInRlsTransaction((rlsTx) => query(rlsTx as unknown as AuditLogRepository));
  }
}

export const auditService = new AuditService();
