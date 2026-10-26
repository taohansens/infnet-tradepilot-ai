import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import JSZip from 'jszip';
import {
  ACCOUNT_DELETE_CONFIRMATION_PHRASE,
  toNumeric4String,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type PrivacyExportJobResponse,
} from '@tradepilot/shared';
import { getRequiredRlsContext } from '../db/rlsContext.js';
import { runInRlsTransaction, type RlsTransactionClient } from '../db/prismaRls.js';
import {
  AuditService,
  auditService as defaultAuditService,
  type AuditLogRepository,
} from './auditService.js';

/**
 * Serviço de Soberania de Dados (LGPD): Exportação Completa (.ZIP com JSON + CSV)
 * e Exclusão Definitiva de Conta com registro imutável na trilha de auditoria.
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-13
 * @rnf RNF-30
 */

export class PrivacyServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'PrivacyServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ExportableUserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  totpEnabled: boolean;
  lgpdConsentAt: Date;
  onboardingCompleted: boolean;
  planCode: string;
  planStatus: string;
  createdAt: Date;
}

export interface ExportableTradeRecord {
  id: string;
  ticker: string;
  marketType: string;
  side: string;
  taxSilo: string;
  source: string;
  isDemo: boolean;
  entryAt: Date;
  exitAt: Date;
  qty: unknown;
  entryPrice: unknown;
  exitPrice: unknown;
  stopPrice: unknown;
  targetPrice: unknown;
  fees: unknown;
  irrf: unknown;
  grossPnl: unknown;
  netPnl: unknown;
  pnlPct: unknown;
  broker: string | null;
  setupName: string | null;
  followedPlan: boolean | null;
  notes: string | null;
  createdAt: Date;
}

export interface PrivacyDataSnapshot {
  user: ExportableUserRecord;
  trades: ExportableTradeRecord[];
  ingestionJobs: unknown[];
  stagingItems: unknown[];
  auditLogs: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeSnapshot: unknown;
    afterSnapshot: unknown;
    createdAtUtc: Date;
  }>;
}

export interface PrivacyRepository {
  collectUserData(userId: string): Promise<PrivacyDataSnapshot | null>;
  deleteUserAccountAtomic(params: {
    userId: string;
    actorId: string;
    requestId?: string;
    ipHash?: string;
    beforeSnapshot: Record<string, unknown>;
    afterSnapshot: Record<string, unknown>;
  }): Promise<{ auditId: string }>;
  recordExportAudit(params: {
    userId: string;
    actorId: string;
    jobId: string;
    requestId?: string;
    ipHash?: string;
    tradesCount: number;
  }): Promise<void>;
}

/**
 * Implementação Prisma + PostgreSQL executando estritamente dentro de transações RLS.
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rnf RNF-11
 * @rnf RNF-13
 * @rnf RNF-30
 */
export class PrismaPrivacyRepository implements PrivacyRepository {
  constructor(private readonly audit: AuditService = defaultAuditService) {}

  public async collectUserData(userId: string): Promise<PrivacyDataSnapshot | null> {
    return runInRlsTransaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) return null;

      const [trades, ingestionJobs, stagingItems, auditLogs] = await Promise.all([
        tx.trade.findMany({ orderBy: { exitAt: 'desc' } }),
        tx.ingestionJob.findMany({ orderBy: { createdAt: 'desc' } }),
        tx.stagingItem.findMany({ orderBy: { createdAt: 'desc' } }),
        tx.auditLog.findMany({ orderBy: { createdAtUtc: 'desc' } }),
      ]);

      return {
        user,
        trades,
        ingestionJobs,
        stagingItems,
        auditLogs,
      };
    });
  }

  public async recordExportAudit(params: {
    userId: string;
    actorId: string;
    jobId: string;
    requestId?: string;
    ipHash?: string;
    tradesCount: number;
  }): Promise<void> {
    await runInRlsTransaction(async (tx) => {
      await this.audit.recordAuditEvent(
        {
          action: 'DATA_EXPORT',
          entityType: 'PRIVACY_EXPORT',
          entityId: params.jobId,
          userId: params.userId,
          actorId: params.actorId,
          requestId: params.requestId,
          ipHash: params.ipHash,
          beforeSnapshot: null,
          afterSnapshot: {
            format: 'zip(json+csv)',
            trades_exported: params.tradesCount,
          },
        },
        tx as RlsTransactionClient,
      );
    });
  }

  public async deleteUserAccountAtomic(params: {
    userId: string;
    actorId: string;
    requestId?: string;
    ipHash?: string;
    beforeSnapshot: Record<string, unknown>;
    afterSnapshot: Record<string, unknown>;
  }): Promise<{ auditId: string }> {
    return runInRlsTransaction(async (tx) => {
      // 1. Grava evento imutável ACCOUNT_DELETE ANTES da exclusão da conta
      //    (audit_logs não possui ON DELETE CASCADE, preservando rastro legal RNF-30).
      const auditRecord = await this.audit.recordAuditEvent(
        {
          action: 'ACCOUNT_DELETE',
          entityType: 'USER',
          entityId: params.userId,
          userId: params.userId,
          actorId: params.actorId,
          requestId: params.requestId,
          ipHash: params.ipHash,
          beforeSnapshot: params.beforeSnapshot,
          afterSnapshot: params.afterSnapshot,
        },
        tx as unknown as AuditLogRepository,
      );

      // 2. Remove definitivamente o titular e todos os dados operacionais em cascata
      await tx.user.delete({ where: { id: params.userId } });

      return { auditId: auditRecord.id };
    });
  }
}

interface StoredExportArtifact {
  jobId: string;
  userId: string;
  status: 'ready';
  zipBuffer: Buffer;
  fileName: string;
  createdAtUtc: string;
  expiresAtMs: number;
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatOptionalDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toNumeric4String(String(value));
}

function buildTradesCsv(trades: ExportableTradeRecord[]): string {
  const header = [
    'id',
    'ticker',
    'market_type',
    'side',
    'tax_silo',
    'source',
    'is_demo',
    'entry_at',
    'exit_at',
    'qty',
    'entry_price',
    'exit_price',
    'stop_price',
    'target_price',
    'fees',
    'irrf',
    'gross_pnl',
    'net_pnl',
    'pnl_pct',
    'broker',
    'setup_name',
    'followed_plan',
  ].join(',');

  const rows = trades.map((t) =>
    [
      t.id,
      t.ticker,
      t.marketType,
      t.side,
      t.taxSilo,
      t.source,
      t.isDemo,
      t.entryAt,
      t.exitAt,
      formatOptionalDecimal(t.qty),
      formatOptionalDecimal(t.entryPrice),
      formatOptionalDecimal(t.exitPrice),
      formatOptionalDecimal(t.stopPrice),
      formatOptionalDecimal(t.targetPrice),
      formatOptionalDecimal(t.fees),
      formatOptionalDecimal(t.irrf),
      formatOptionalDecimal(t.grossPnl),
      formatOptionalDecimal(t.netPnl),
      formatOptionalDecimal(t.pnlPct),
      t.broker,
      t.setupName,
      t.followedPlan,
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return [header, ...rows].join('\n');
}

function buildAuditCsv(logs: PrivacyDataSnapshot['auditLogs']): string {
  const header = [
    'id',
    'action',
    'entity_type',
    'entity_id',
    'created_at_utc',
    'before_snapshot',
    'after_snapshot',
  ].join(',');

  const rows = logs.map((l) =>
    [
      l.id,
      l.action,
      l.entityType,
      l.entityId,
      l.createdAtUtc,
      l.beforeSnapshot ? JSON.stringify(l.beforeSnapshot) : '',
      l.afterSnapshot ? JSON.stringify(l.afterSnapshot) : '',
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return [header, ...rows].join('\n');
}

const EXPORT_TTL_MS = 15 * 60 * 1000; // 15 minutos

/**
 * Serviço LGPD para exportação em `.zip` (JSON + CSV) e exclusão irreversível de conta.
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-13
 * @rnf RNF-30
 */
export class PrivacyService {
  private readonly repository: PrivacyRepository;
  private readonly exportArtifacts = new Map<string, StoredExportArtifact>();

  constructor(repository?: PrivacyRepository) {
    this.repository = repository ?? new PrismaPrivacyRepository();
  }

  /**
   * Gera pacote `.zip` contendo JSON e CSV com todos os dados do titular
   * e registra evento `DATA_EXPORT` na trilha imutável `audit_logs`.
   *
   * @spec SPEC-03
   * @spec SPEC-04
   * @rf RF-T-4
   * @rnf RNF-13
   * @rnf RNF-30
   */
  public async createDataExport(): Promise<PrivacyExportJobResponse> {
    const ctx = getRequiredRlsContext();
    const snapshot = await this.repository.collectUserData(ctx.userId);

    if (!snapshot) {
      throw new PrivacyServiceError(
        404,
        'USER_NOT_FOUND',
        'Conta do titular não encontrada.',
      );
    }

    const jobId = randomUUID();
    const createdAtUtc = new Date().toISOString();

    const sanitizedUser = {
      id: snapshot.user.id,
      name: snapshot.user.name,
      email: snapshot.user.email,
      totp_enabled: snapshot.user.totpEnabled,
      lgpd_consent_at: snapshot.user.lgpdConsentAt.toISOString(),
      onboarding_completed: snapshot.user.onboardingCompleted,
      plan_code: snapshot.user.planCode,
      plan_status: snapshot.user.planStatus,
      created_at: snapshot.user.createdAt.toISOString(),
    };

    const normalizedTrades = snapshot.trades.map((t) => ({
      ...t,
      entryAt: t.entryAt.toISOString(),
      exitAt: t.exitAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      qty: formatOptionalDecimal(t.qty),
      entryPrice: formatOptionalDecimal(t.entryPrice),
      exitPrice: formatOptionalDecimal(t.exitPrice),
      stopPrice: formatOptionalDecimal(t.stopPrice),
      targetPrice: formatOptionalDecimal(t.targetPrice),
      fees: formatOptionalDecimal(t.fees),
      irrf: formatOptionalDecimal(t.irrf),
      grossPnl: formatOptionalDecimal(t.grossPnl),
      netPnl: formatOptionalDecimal(t.netPnl),
      pnlPct: formatOptionalDecimal(t.pnlPct),
    }));

    const zip = new JSZip();
    zip.file(
      'README_LGPD.txt',
      [
        'TradePilot AI — Exportação Completa de Dados do Titular (LGPD - Lei 13.709/2018)',
        `Gerado em (UTC): ${createdAtUtc}`,
        `Job ID: ${jobId}`,
        '',
        'Arquivos incluídos:',
        '- user.json: Perfil e consentimento LGPD (sem hashes de senha ou segredos 2FA)',
        '- trades.json / trades.csv: Histórico completo de operações com precisão decimal exata',
        '- ingestion_jobs.json / staging_items.json: Histórico de importações e conciliações',
        '- audit_logs.json / audit_logs.csv: Trilha de auditoria imutável (append-only)',
      ].join('\n'),
    );
    zip.file('user.json', JSON.stringify(sanitizedUser, null, 2));
    zip.file('trades.json', JSON.stringify(normalizedTrades, null, 2));
    zip.file('trades.csv', buildTradesCsv(snapshot.trades));
    zip.file('ingestion_jobs.json', JSON.stringify(snapshot.ingestionJobs, null, 2));
    zip.file('staging_items.json', JSON.stringify(snapshot.stagingItems, null, 2));
    zip.file('audit_logs.json', JSON.stringify(snapshot.auditLogs, null, 2));
    zip.file('audit_logs.csv', buildAuditCsv(snapshot.auditLogs));

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const dateTag = createdAtUtc.slice(0, 10);
    this.exportArtifacts.set(jobId, {
      jobId,
      userId: ctx.userId,
      status: 'ready',
      zipBuffer,
      fileName: `tradepilot-dados-lgpd-${dateTag}.zip`,
      createdAtUtc,
      expiresAtMs: Date.now() + EXPORT_TTL_MS,
    });

    await this.repository.recordExportAudit({
      userId: ctx.userId,
      actorId: ctx.userId,
      jobId,
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      tradesCount: snapshot.trades.length,
    });

    return {
      job_id: jobId,
      status: 'ready',
      estimated_seconds: 30,
      download_url: `/api/v1/privacy/export/${jobId}/download`,
      created_at_utc: createdAtUtc,
    };
  }

  /**
   * Obtém o arquivo `.zip` gerado exclusivamente para o titular autenticado (`RNF-11`).
   *
   * @spec SPEC-03
   * @rf RF-T-4
   * @rnf RNF-11
   */
  public getExportDownload(jobId: string): { buffer: Buffer; fileName: string } {
    const ctx = getRequiredRlsContext();
    const artifact = this.exportArtifacts.get(jobId);

    if (!artifact || artifact.userId !== ctx.userId) {
      throw new PrivacyServiceError(
        404,
        'EXPORT_NOT_FOUND',
        'Arquivo de exportação não encontrado ou não pertence à sua conta.',
      );
    }

    if (Date.now() > artifact.expiresAtMs) {
      this.exportArtifacts.delete(jobId);
      throw new PrivacyServiceError(
        410,
        'EXPORT_EXPIRED',
        'O link temporário de exportação expirou. Solicite uma nova exportação.',
      );
    }

    return { buffer: artifact.zipBuffer, fileName: artifact.fileName };
  }

  /**
   * Executa exclusão definitiva de conta e dados pessoais/financeiros (LGPD),
   * exigindo confirmação dupla (`"EXCLUIR MINHA CONTA"` + senha atual) e
   * preservando registro mínimo anonimizado na `audit_logs` (`SPEC-04`, `RNF-30`).
   *
   * @spec SPEC-03
   * @spec SPEC-04
   * @rf RF-T-4
   * @rnf RNF-11
   * @rnf RNF-13
   * @rnf RNF-30
   */
  public async deleteAccount(
    input: DeleteAccountRequest,
  ): Promise<DeleteAccountResponse> {
    const ctx = getRequiredRlsContext();

    if (input.confirmation_phrase !== ACCOUNT_DELETE_CONFIRMATION_PHRASE) {
      throw new PrivacyServiceError(
        400,
        'INVALID_CONFIRMATION_PHRASE',
        `Para confirmar a exclusão irreversível, digite exatamente "${ACCOUNT_DELETE_CONFIRMATION_PHRASE}".`,
      );
    }

    if (typeof input.password !== 'string' || input.password.length === 0) {
      throw new PrivacyServiceError(
        400,
        'PASSWORD_REQUIRED',
        'Informe sua senha atual para confirmar a exclusão da conta.',
      );
    }

    const snapshot = await this.repository.collectUserData(ctx.userId);
    if (!snapshot) {
      throw new PrivacyServiceError(
        404,
        'USER_NOT_FOUND',
        'Conta não encontrada.',
      );
    }

    const passwordValid = await bcrypt.compare(
      input.password,
      snapshot.user.passwordHash,
    );
    if (!passwordValid) {
      throw new PrivacyServiceError(
        401,
        'INVALID_PASSWORD',
        'Senha atual incorreta. A exclusão da conta foi cancelada.',
      );
    }

    const emailHash = createHash('sha256')
      .update(snapshot.user.email.toLowerCase(), 'utf8')
      .digest('hex');

    const { auditId } = await this.repository.deleteUserAccountAtomic({
      userId: ctx.userId,
      actorId: ctx.userId,
      requestId: ctx.requestId,
      ipHash: ctx.ipHash,
      beforeSnapshot: {
        email_sha256: emailHash,
        plan_status: snapshot.user.planStatus,
        trades_count: snapshot.trades.length,
      },
      afterSnapshot: {
        anonymized: true,
        personal_data_removed: true,
        deleted_at_utc: new Date().toISOString(),
      },
    });

    // Remove quaisquer artefatos temporários de exportação da memória
    for (const [jobId, artifact] of this.exportArtifacts.entries()) {
      if (artifact.userId === ctx.userId) {
        this.exportArtifacts.delete(jobId);
      }
    }

    return {
      deleted: true,
      audit_id: auditId,
      message:
        'Sua conta e todos os dados pessoais e financeiros foram excluídos definitivamente conforme a LGPD.',
    };
  }
}

export const privacyService = new PrivacyService();
