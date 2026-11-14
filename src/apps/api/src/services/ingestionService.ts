import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  CONCILIATION_ACTIONS,
  toDecimal,
  toNumeric4String,
  type CommitIngestionJobRequest,
  type CommitIngestionJobResponse,
  type ConciliationAction,
  type CreateIngestionJobResponse,
  type IngestionJobDetailResponse,
  type IngestionJobStatus,
  type MarketType,
  type OrderSide,
  type UploadSourceHint,
} from '@tradepilot/shared';
import {
  getRequiredRlsContext,
  isValidUuid,
  runWithRlsContext,
  type RlsContext,
} from '../db/rlsContext.js';
import { runInRlsTransaction, type RlsTransactionClient } from '../db/prismaRls.js';
import {
  AuditService,
  auditService as defaultAuditService,
  type AuditLogRepository,
} from './auditService.js';
import {
  IngestionParseError,
  parseIngestionFile,
  type ReconstructedTradeMeta,
} from './ingestionParser.js';
import {
  DEFAULT_B3_INSTRUMENT_CONFIGS,
  instrumentService,
} from './instrumentService.js';
import {
  classifyStagingRows,
  type ClassifiedStagingRow,
  type ExistingTradeForDedup,
} from './deduplicationEngine.js';

/**
 * Serviço de Ingestão Assíncrona, Deduplicação e Commit Atômico com Auditoria.
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @spec SPEC-04
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-11
 * @rnf RNF-20
 * @rnf RNF-30
 */

export class IngestionServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'IngestionServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface StoredStagingItem {
  id: string;
  jobId: string;
  userId: string;
  rowNumber: number;
  broker: string | null;
  tradeDate: Date;
  executedAt: Date;
  ticker: string;
  marketType: string;
  side: string;
  qty: string;
  price: string;
  fees: string;
  irrf: string;
  dedupHash: string;
  dedupStatus: 'NEW' | 'EXACT_DUPLICATE' | 'CONFLICT';
  matchedTradeId: string | null;
  diffFields: string[];
  resolutionAction: string | null;
  rawPayload?: Record<string, unknown> | null;
  matchedTrade?: {
    id: string;
    ticker: string;
    side: string;
    qty: string;
    entryPrice: string;
    exitPrice: string;
    fees: string;
    irrf: string;
    grossPnl: string;
    netPnl: string;
    source: string;
    broker: string | null;
  } | null;
}

export interface StoredIngestionJob {
  id: string;
  userId: string;
  sourceHint: UploadSourceHint;
  fileName: string;
  fileSha256: string;
  status: IngestionJobStatus;
  totalRows: number;
  processedRows: number;
  conflictCount: number;
  errorMessagePtbr: string | null;
  createdAt: Date;
  completedAt: Date | null;
  stagingItems: StoredStagingItem[];
}

export interface IngestionRepository {
  createQueuedJob(params: {
    userId: string;
    sourceHint: UploadSourceHint;
    fileName: string;
    fileSha256: string;
  }): Promise<{ id: string; fileName: string }>;
  markJobProcessing(jobId: string): Promise<void>;
  findExistingTradesByHashes(
    userId: string,
    hashes: string[],
  ): Promise<ExistingTradeForDedup[]>;
  saveStagingAndMarkReview(params: {
    jobId: string;
    userId: string;
    rows: ClassifiedStagingRow[];
  }): Promise<void>;
  markJobFailed(jobId: string, errorMessagePtBr: string): Promise<void>;
  getJobWithItems(jobId: string): Promise<StoredIngestionJob | null>;
  commitJobAtomic(params: {
    job: StoredIngestionJob;
    resolutionsByItemId: Map<string, ConciliationAction>;
    ctx: RlsContext;
  }): Promise<CommitIngestionJobResponse>;
}

function inferDefaultTaxSilo(marketType: string): 'DAY_TRADE' | 'SWING_TRADE' {
  return marketType === 'WIN' || marketType === 'WDO'
    ? 'DAY_TRADE'
    : 'SWING_TRADE';
}

function mapOrderSideToTradeSide(side: string): 'LONG' | 'SHORT' {
  return side === 'SELL' ? 'SHORT' : 'LONG';
}

/**
 * Implementação Prisma + PostgreSQL sob Row-Level Security (`RNF-11`).
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rnf RNF-9
 * @rnf RNF-11
 * @rnf RNF-30
 */
export class PrismaIngestionRepository implements IngestionRepository {
  constructor(private readonly audit: AuditService = defaultAuditService) {}

  public async createQueuedJob(params: {
    userId: string;
    sourceHint: UploadSourceHint;
    fileName: string;
    fileSha256: string;
  }): Promise<{ id: string; fileName: string }> {
    return runInRlsTransaction(async (tx) => {
      const created = await tx.ingestionJob.create({
        data: {
          userId: params.userId,
          sourceHint: params.sourceHint,
          fileName: params.fileName,
          fileSha256: params.fileSha256,
          status: 'QUEUED',
        },
      });
      return { id: created.id, fileName: created.fileName };
    });
  }

  public async markJobProcessing(jobId: string): Promise<void> {
    await runInRlsTransaction(async (tx) => {
      await tx.ingestionJob.update({
        where: { id: jobId },
        data: { status: 'PROCESSING' },
      });
    });
  }

  public async findExistingTradesByHashes(
    userId: string,
    hashes: string[],
  ): Promise<ExistingTradeForDedup[]> {
    if (hashes.length === 0) return [];
    return runInRlsTransaction(async (tx) => {
      const trades = await tx.trade.findMany({
        where: {
          userId,
          dedupHash: { in: hashes },
        },
        select: {
          id: true,
          dedupHash: true,
          fees: true,
          irrf: true,
        },
      });

      return trades
        .filter((t): t is typeof t & { dedupHash: string } => t.dedupHash !== null)
        .map((t) => ({
          id: t.id,
          dedupHash: t.dedupHash,
          fees: toNumeric4String(t.fees.toString()),
          irrf: toNumeric4String(t.irrf.toString()),
        }));
    });
  }

  public async saveStagingAndMarkReview(params: {
    jobId: string;
    userId: string;
    rows: ClassifiedStagingRow[];
  }): Promise<void> {
    const conflictCount = params.rows.filter(
      (r) => r.dedupStatus === 'CONFLICT',
    ).length;

    await runInRlsTransaction(async (tx) => {
      await tx.stagingItem.createMany({
        data: params.rows.map((r) => ({
          userId: params.userId,
          jobId: params.jobId,
          rowNumber: r.rowNumber,
          broker: r.broker,
          tradeDate: r.tradeDate,
          executedAt: r.executedAt,
          ticker: r.ticker,
          marketType: r.marketType,
          side: r.side,
          qty: new Prisma.Decimal(r.qty),
          price: new Prisma.Decimal(r.price),
          fees: new Prisma.Decimal(r.fees),
          irrf: new Prisma.Decimal(r.irrf),
          dedupHash: r.dedupHash,
          dedupStatus: r.dedupStatus,
          matchedTradeId: r.matchedTradeId,
          diffFields: r.diffFields,
          rawPayload: r.rawPayload as Prisma.InputJsonValue,
        })),
      });

      await tx.ingestionJob.update({
        where: { id: params.jobId },
        data: {
          status: 'AWAITING_REVIEW',
          totalRows: params.rows.length,
          processedRows: params.rows.length,
          conflictCount,
        },
      });
    });
  }

  public async markJobFailed(
    jobId: string,
    errorMessagePtBr: string,
  ): Promise<void> {
    await runInRlsTransaction(async (tx) => {
      await tx.ingestionJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessagePtbr: errorMessagePtBr,
          completedAt: new Date(),
        },
      });
    });
  }

  public async getJobWithItems(
    jobId: string,
  ): Promise<StoredIngestionJob | null> {
    return runInRlsTransaction(async (tx) => {
      const job = await tx.ingestionJob.findUnique({
        where: { id: jobId },
        include: {
          stagingItems: {
            orderBy: { rowNumber: 'asc' },
            include: {
              matchedTrade: true,
            },
          },
        },
      });

      if (!job) return null;

      return {
        id: job.id,
        userId: job.userId,
        sourceHint: job.sourceHint as UploadSourceHint,
        fileName: job.fileName,
        fileSha256: job.fileSha256,
        status: job.status as IngestionJobStatus,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
        conflictCount: job.conflictCount,
        errorMessagePtbr: job.errorMessagePtbr,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        stagingItems: job.stagingItems.map((item) => ({
          id: item.id,
          jobId: item.jobId,
          userId: item.userId,
          rowNumber: item.rowNumber,
          broker: item.broker,
          tradeDate: item.tradeDate,
          executedAt: item.executedAt,
          ticker: item.ticker,
          marketType: item.marketType,
          side: item.side,
          qty: toNumeric4String(item.qty.toString()),
          price: toNumeric4String(item.price.toString()),
          fees: toNumeric4String(item.fees.toString()),
          irrf: toNumeric4String(item.irrf.toString()),
          dedupHash: item.dedupHash,
          dedupStatus: item.dedupStatus as 'NEW' | 'EXACT_DUPLICATE' | 'CONFLICT',
          matchedTradeId: item.matchedTradeId,
          diffFields: item.diffFields,
          resolutionAction: item.resolutionAction,
          rawPayload:
            item.rawPayload && typeof item.rawPayload === 'object'
              ? (item.rawPayload as Record<string, unknown>)
              : null,
          matchedTrade: item.matchedTrade
            ? {
                id: item.matchedTrade.id,
                ticker: item.matchedTrade.ticker,
                side: item.matchedTrade.side,
                qty: toNumeric4String(item.matchedTrade.qty.toString()),
                entryPrice: toNumeric4String(item.matchedTrade.entryPrice.toString()),
                exitPrice: toNumeric4String(item.matchedTrade.exitPrice.toString()),
                fees: toNumeric4String(item.matchedTrade.fees.toString()),
                irrf: toNumeric4String(item.matchedTrade.irrf.toString()),
                grossPnl: toNumeric4String(item.matchedTrade.grossPnl.toString()),
                netPnl: toNumeric4String(item.matchedTrade.netPnl.toString()),
                source: item.matchedTrade.source,
                broker: item.matchedTrade.broker,
              }
            : null,
        })),
      };
    });
  }

  public async commitJobAtomic(params: {
    job: StoredIngestionJob;
    resolutionsByItemId: Map<string, ConciliationAction>;
    ctx: RlsContext;
  }): Promise<CommitIngestionJobResponse> {
    return runInRlsTransaction(
      async (tx) => {
        // Lock pessimista (FOR UPDATE) na linha do job para impedir TOCTOU / duplo clique concorrente (RNF-9)
        const lockedJobs = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM ingestion_jobs WHERE id = ${params.job.id}::uuid FOR UPDATE
        `;
        const lockedStatus = lockedJobs[0]?.status;
        if (!lockedStatus) {
          throw new IngestionServiceError(
            404,
            'JOB_NOT_FOUND',
            'Importação não encontrada para a sua conta.',
          );
        }
        if (lockedStatus === 'COMMITTED') {
          throw new IngestionServiceError(
            409,
            'JOB_ALREADY_COMMITTED',
            'Esta importação já foi confirmada e salva no seu Diário.',
          );
        }
        if (lockedStatus !== 'AWAITING_REVIEW') {
          throw new IngestionServiceError(
            409,
            'JOB_NOT_READY_FOR_COMMIT',
            'A importação ainda está em processamento ou falhou na validação e não pode ser confirmada.',
          );
        }

        let merged = 0;
        let overwritten = 0;
        let ignored = 0;
        const newTradesToInsert: Prisma.TradeCreateManyInput[] = [];

        for (const item of params.job.stagingItems) {
          const explicitAction = params.resolutionsByItemId.get(item.id);

          if (item.dedupStatus === 'NEW') {
            if (explicitAction === 'IGNORE') {
              ignored += 1;
              await tx.stagingItem.update({
                where: { id: item.id },
                data: { resolutionAction: 'IGNORE' },
              });
              continue;
            }

            const reconstructed = (item.rawPayload as { _reconstructed?: ReconstructedTradeMeta } | null)
              ?._reconstructed;
            const entryAt = reconstructed?.entry_at
              ? new Date(reconstructed.entry_at)
              : item.executedAt;
            const exitAt = reconstructed?.exit_at
              ? new Date(reconstructed.exit_at)
              : item.executedAt;
            const exitPriceStr = reconstructed?.exit_price ?? item.price;
            const grossPnlDec = reconstructed?.gross_pnl
              ? toDecimal(reconstructed.gross_pnl)
              : toDecimal('0');
            const feesDec = toDecimal(item.fees);
            const irrfDec = toDecimal(item.irrf);
            const netPnlDec = grossPnlDec.minus(feesDec).minus(irrfDec);

            const entryBrtDay = new Date(entryAt.getTime() - 3 * 3600_000)
              .toISOString()
              .slice(0, 10);
            const exitBrtDay = new Date(exitAt.getTime() - 3 * 3600_000)
              .toISOString()
              .slice(0, 10);
            const taxSilo =
              entryBrtDay === exitBrtDay
                ? 'DAY_TRADE'
                : inferDefaultTaxSilo(item.marketType);

            newTradesToInsert.push({
              userId: params.ctx.userId,
              ticker: item.ticker,
              marketType: item.marketType,
              side: mapOrderSideToTradeSide(item.side),
              taxSilo,
              source: params.job.sourceHint,
              isDemo: false,
              entryAt,
              exitAt,
              qty: new Prisma.Decimal(item.qty),
              entryPrice: new Prisma.Decimal(item.price),
              exitPrice: new Prisma.Decimal(exitPriceStr),
              fees: new Prisma.Decimal(item.fees),
              irrf: new Prisma.Decimal(item.irrf),
              grossPnl: new Prisma.Decimal(toNumeric4String(grossPnlDec)),
              netPnl: new Prisma.Decimal(toNumeric4String(netPnlDec)),
              dedupHash: item.dedupHash,
              broker: item.broker,
              setupName: reconstructed?.setup_name ?? null,
            });
            continue;
          }

          // Itens EXACT_DUPLICATE ou CONFLICT
          const action: ConciliationAction =
            explicitAction ??
            (item.dedupStatus === 'EXACT_DUPLICATE' ? 'IGNORE' : 'MERGE_COSTS');

          if (action === 'IGNORE' || !item.matchedTradeId) {
            ignored += 1;
            await tx.stagingItem.update({
              where: { id: item.id },
              data: { resolutionAction: 'IGNORE' },
            });
            continue;
          }

          // Relê o trade atual DENTRO da transação para evitar sobrescrever dados stale
          const freshTrade = await tx.trade.findUnique({
            where: { id: item.matchedTradeId },
          });
          if (!freshTrade) {
            ignored += 1;
            await tx.stagingItem.update({
              where: { id: item.id },
              data: { resolutionAction: 'IGNORE' },
            });
            continue;
          }

          const existingGross = toNumeric4String(freshTrade.grossPnl.toString());
          const existingFees = toNumeric4String(freshTrade.fees.toString());
          const existingIrrf = toNumeric4String(freshTrade.irrf.toString());
          const existingNet = toNumeric4String(freshTrade.netPnl.toString());
          const existingEntry = toNumeric4String(freshTrade.entryPrice.toString());

          if (action === 'MERGE_COSTS') {
            const recalculatedNet = toNumeric4String(
              toDecimal(existingGross)
                .minus(toDecimal(item.fees))
                .minus(toDecimal(item.irrf)),
            );

            await tx.trade.update({
              where: { id: freshTrade.id },
              data: {
                fees: new Prisma.Decimal(item.fees),
                irrf: new Prisma.Decimal(item.irrf),
                netPnl: new Prisma.Decimal(recalculatedNet),
              },
            });

            await tx.stagingItem.update({
              where: { id: item.id },
              data: { resolutionAction: 'MERGE_COSTS' },
            });

            await this.audit.recordAuditEvent(
              {
                action: 'CONCILIATION_MERGE',
                entityType: 'TRADE',
                entityId: freshTrade.id,
                userId: params.ctx.userId,
                actorId: params.ctx.userId,
                requestId: params.ctx.requestId,
                ipHash: params.ctx.ipHash,
                beforeSnapshot: {
                  resolution: 'MERGE_COSTS',
                  job_id: params.job.id,
                  fees: existingFees,
                  irrf: existingIrrf,
                  net_pnl: existingNet,
                },
                afterSnapshot: {
                  resolution: 'MERGE_COSTS',
                  job_id: params.job.id,
                  fees: item.fees,
                  irrf: item.irrf,
                  net_pnl: recalculatedNet,
                },
              },
              tx as unknown as AuditLogRepository,
            );

            merged += 1;
            continue;
          }

          if (action === 'OVERWRITE') {
            const recalculatedNet = toNumeric4String(
              toDecimal(existingGross)
                .minus(toDecimal(item.fees))
                .minus(toDecimal(item.irrf)),
            );

            await tx.trade.update({
              where: { id: freshTrade.id },
              data: {
                entryPrice: new Prisma.Decimal(item.price),
                exitPrice: new Prisma.Decimal(item.price),
                qty: new Prisma.Decimal(item.qty),
                fees: new Prisma.Decimal(item.fees),
                irrf: new Prisma.Decimal(item.irrf),
                netPnl: new Prisma.Decimal(recalculatedNet),
                broker: item.broker,
                source: params.job.sourceHint,
              },
            });

            await tx.stagingItem.update({
              where: { id: item.id },
              data: { resolutionAction: 'OVERWRITE' },
            });

            await this.audit.recordAuditEvent(
              {
                action: 'CONCILIATION_MERGE',
                entityType: 'TRADE',
                entityId: freshTrade.id,
                userId: params.ctx.userId,
                actorId: params.ctx.userId,
                requestId: params.ctx.requestId,
                ipHash: params.ctx.ipHash,
                beforeSnapshot: {
                  resolution: 'OVERWRITE',
                  job_id: params.job.id,
                  entry_price: existingEntry,
                  fees: existingFees,
                  irrf: existingIrrf,
                  net_pnl: existingNet,
                  source: freshTrade.source,
                },
                afterSnapshot: {
                  resolution: 'OVERWRITE',
                  job_id: params.job.id,
                  entry_price: item.price,
                  fees: item.fees,
                  irrf: item.irrf,
                  net_pnl: recalculatedNet,
                  source: params.job.sourceHint,
                },
              },
              tx as unknown as RlsTransactionClient as unknown as AuditLogRepository,
            );

            overwritten += 1;
          }
        }

        // Inserção em lote idempotente para escalar até 20.000 linhas dentro do SLA (RNF-3, RNF-9)
        let inserted = 0;
        if (newTradesToInsert.length > 0) {
          const batchResult = await tx.trade.createMany({
            data: newTradesToInsert,
            skipDuplicates: true,
          });
          inserted = batchResult.count;
        }

        await tx.ingestionJob.update({
          where: { id: params.job.id },
          data: {
            status: 'COMMITTED',
            completedAt: new Date(),
          },
        });

        return {
          job_id: params.job.id,
          inserted,
          merged,
          overwritten,
          ignored,
        };
      },
      undefined,
      params.ctx,
      { maxWait: 10_000, timeout: 60_000 },
    );
  }
}

export interface IngestionServiceOptions {
  repository?: IngestionRepository;
  /** Em testes, permite executar o worker de forma controlada ou assíncrona via setImmediate. */
  scheduleWorker?: (task: () => Promise<void>) => void;
}

/**
 * Orquestrador da Ingestão Assíncrona (SPEC-06), Deduplicação (SPEC-08) e Commit (SPEC-09).
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-30
 */
export class IngestionService {
  private readonly repository: IngestionRepository;
  private readonly scheduleWorker: (task: () => Promise<void>) => void;

  constructor(options: IngestionServiceOptions = {}) {
    this.repository = options.repository ?? new PrismaIngestionRepository();
    this.scheduleWorker =
      options.scheduleWorker ??
      ((task) => {
        setImmediate(() => {
          void task();
        });
      });
  }

  /**
   * Recebe arquivo CSV/XLSX, cria o job em fila (`QUEUED`) e dispara o worker
   * assíncrono em staging (`ADR-01`), retornando `job_id` imediatamente (202 Accepted).
   *
   * @spec SPEC-06
   * @rf RF-M1-5
   * @rnf RNF-3
   * @rnf RNF-11
   */
  public async enqueueIngestionJob(params: {
    fileBuffer: Buffer;
    fileName: string;
    sourceHint: string;
  }): Promise<CreateIngestionJobResponse> {
    const ctx = getRequiredRlsContext();

    if (!params.fileBuffer || params.fileBuffer.length === 0) {
      throw new IngestionServiceError(
        400,
        'EMPTY_FILE',
        'Nenhum arquivo válido foi enviado. Selecione um extrato CSV ou XLSX.',
      );
    }

    const lowerName = params.fileName.toLowerCase();
    if (
      !lowerName.endsWith('.csv') &&
      !lowerName.endsWith('.xlsx') &&
      !lowerName.endsWith('.xls')
    ) {
      throw new IngestionServiceError(
        400,
        'UNSUPPORTED_FILE_FORMAT',
        'Formato de arquivo não suportado. Envie um arquivo CSV ou XLSX do Extrato B3 ou do Profit.',
      );
    }

    const normalizedHint: UploadSourceHint =
      params.sourceHint === 'PROFIT_CSV' ? 'PROFIT_CSV' : 'B3_CSV';

    const fileSha256 = createHash('sha256')
      .update(params.fileBuffer)
      .digest('hex');

    const queued = await this.repository.createQueuedJob({
      userId: ctx.userId,
      sourceHint: normalizedHint,
      fileName: params.fileName,
      fileSha256,
    });

    this.scheduleWorker(async () => {
      await runWithRlsContext(ctx, async () => {
        await this.processJobInBackground({
          jobId: queued.id,
          userId: ctx.userId,
          fileBuffer: params.fileBuffer,
          fileName: params.fileName,
          sourceHint: normalizedHint,
        });
      });
    });

    return {
      job_id: queued.id,
      status: 'queued',
      file_name: queued.fileName,
    };
  }

  /**
   * Worker assíncrono que executa parsing, deduplicação SHA-256 e gravação em staging.
   *
   * @spec SPEC-06
   * @spec SPEC-08
   * @rnf RNF-3
   * @rnf RNF-9
   */
  public async processJobInBackground(params: {
    jobId: string;
    userId: string;
    fileBuffer: Buffer;
    fileName: string;
    sourceHint: UploadSourceHint;
  }): Promise<void> {
    try {
      await this.repository.markJobProcessing(params.jobId);

      const instrumentConfigs = await instrumentService
        .listUserConfigs()
        .catch(() => DEFAULT_B3_INSTRUMENT_CONFIGS);

      const parsedRows = parseIngestionFile({
        fileBuffer: params.fileBuffer,
        fileName: params.fileName,
        sourceHint: params.sourceHint,
        instrumentConfigs,
      });

      // Pré-calcula hashes para buscar apenas trades potencialmente conflitantes
      const preliminary = classifyStagingRows({
        userId: params.userId,
        rows: parsedRows,
        existingTrades: [],
      });
      const uniqueHashes = [...new Set(preliminary.map((r) => r.dedupHash))];

      const existingTrades = await this.repository.findExistingTradesByHashes(
        params.userId,
        uniqueHashes,
      );

      const classifiedRows = classifyStagingRows({
        userId: params.userId,
        rows: parsedRows,
        existingTrades,
      });

      await this.repository.saveStagingAndMarkReview({
        jobId: params.jobId,
        userId: params.userId,
        rows: classifiedRows,
      });
    } catch (error) {
      const friendlyMessage =
        error instanceof IngestionParseError
          ? error.message
          : 'Não foi possível processar o extrato enviado. Verifique se o arquivo está íntegro e no padrão B3 ou Profit.';
      await this.repository.markJobFailed(params.jobId, friendlyMessage);
    }
  }

  /**
   * Consulta o progresso e os itens em staging de um job de ingestão do usuário.
   *
   * @spec SPEC-06
   * @spec SPEC-09
   * @rf RF-M1-6
   * @rnf RNF-11
   */
  public async getJobDetail(jobId: string): Promise<IngestionJobDetailResponse> {
    if (!isValidUuid(jobId)) {
      throw new IngestionServiceError(
        400,
        'INVALID_JOB_ID',
        'Identificador de importação inválido.',
      );
    }

    const job = await this.repository.getJobWithItems(jobId);
    if (!job) {
      throw new IngestionServiceError(
        404,
        'JOB_NOT_FOUND',
        'Importação não encontrada para a sua conta.',
      );
    }

    const newCount = job.stagingItems.filter(
      (i) => i.dedupStatus === 'NEW',
    ).length;
    const exactDuplicateCount = job.stagingItems.filter(
      (i) => i.dedupStatus === 'EXACT_DUPLICATE',
    ).length;
    const conflictCount = job.stagingItems.filter(
      (i) => i.dedupStatus === 'CONFLICT',
    ).length;

    const progressPct =
      job.status === 'QUEUED'
        ? 10
        : job.status === 'PROCESSING'
          ? 55
          : 100;

    return {
      job_id: job.id,
      source_hint: job.sourceHint,
      file_name: job.fileName,
      status: job.status,
      total_rows: job.totalRows,
      processed_rows: job.processedRows,
      progress_pct: progressPct,
      summary: {
        new_count: newCount,
        exact_duplicate_count: exactDuplicateCount,
        conflict_count: conflictCount,
      },
      error_message_ptbr: job.errorMessagePtbr,
      created_at: job.createdAt.toISOString(),
      completed_at: job.completedAt ? job.completedAt.toISOString() : null,
      items: job.stagingItems.map((item) => ({
        staging_item_id: item.id,
        row_number: item.rowNumber,
        broker: item.broker,
        trade_date: item.tradeDate.toISOString().slice(0, 10),
        executed_at: item.executedAt.toISOString(),
        ticker: item.ticker,
        market_type: item.marketType as MarketType,
        side: item.side as OrderSide,
        qty: item.qty,
        price: item.price,
        fees: item.fees,
        irrf: item.irrf,
        dedup_status: item.dedupStatus,
        matched_trade_id: item.matchedTradeId,
        matched_trade: item.matchedTrade
          ? {
              id: item.matchedTrade.id,
              ticker: item.matchedTrade.ticker,
              side: item.matchedTrade.side,
              qty: item.matchedTrade.qty,
              entry_price: item.matchedTrade.entryPrice,
              fees: item.matchedTrade.fees,
              irrf: item.matchedTrade.irrf,
              net_pnl: item.matchedTrade.netPnl,
              source: item.matchedTrade.source,
              broker: item.matchedTrade.broker,
            }
          : null,
        diff_fields: item.diffFields,
        recommended_action:
          item.dedupStatus === 'CONFLICT'
            ? 'MERGE_COSTS'
            : item.dedupStatus === 'EXACT_DUPLICATE'
              ? 'IGNORE'
              : null,
      })),
    };
  }

  /**
   * Efetiva o lote em staging aplicando resoluções (`IGNORE`, `OVERWRITE`, `MERGE_COSTS`)
   * em uma única transação atômica PostgreSQL com trilha em `audit_logs`.
   *
   * @spec SPEC-09
   * @spec SPEC-04
   * @rf RF-M1-6
   * @rf RF-M1-7
   * @rnf RNF-9
   * @rnf RNF-11
   * @rnf RNF-30
   */
  public async commitJob(
    jobId: string,
    body: CommitIngestionJobRequest,
  ): Promise<CommitIngestionJobResponse> {
    const ctx = getRequiredRlsContext();

    if (!isValidUuid(jobId)) {
      throw new IngestionServiceError(
        400,
        'INVALID_JOB_ID',
        'Identificador de importação inválido.',
      );
    }

    const job = await this.repository.getJobWithItems(jobId);
    if (!job) {
      throw new IngestionServiceError(
        404,
        'JOB_NOT_FOUND',
        'Importação não encontrada para a sua conta.',
      );
    }

    if (job.status === 'COMMITTED') {
      throw new IngestionServiceError(
        409,
        'JOB_ALREADY_COMMITTED',
        'Esta importação já foi confirmada e salva no seu Diário.',
      );
    }

    if (job.status !== 'AWAITING_REVIEW') {
      throw new IngestionServiceError(
        409,
        'JOB_NOT_READY_FOR_COMMIT',
        'A importação ainda está em processamento ou falhou na validação e não pode ser confirmada.',
      );
    }

    const resolutionsList = Array.isArray(body?.resolutions)
      ? body.resolutions
      : [];
    const resolutionsByItemId = new Map<string, ConciliationAction>();

    for (const res of resolutionsList) {
      if (
        !res ||
        typeof res.staging_item_id !== 'string' ||
        !CONCILIATION_ACTIONS.includes(res.action)
      ) {
        throw new IngestionServiceError(
          400,
          'INVALID_RESOLUTION_ACTION',
          'Ação de conciliação inválida. Escolha Ignorar duplicata, Sobrescrever ou Mesclar custos.',
        );
      }
      resolutionsByItemId.set(res.staging_item_id, res.action);
    }

    // Garante que todos os conflitos tenham decisão explícita do usuário (SPEC-09)
    const unresolvedConflicts = job.stagingItems.filter(
      (item) =>
        item.dedupStatus === 'CONFLICT' && !resolutionsByItemId.has(item.id),
    );
    if (unresolvedConflicts.length > 0) {
      throw new IngestionServiceError(
        400,
        'UNRESOLVED_CONFLICTS',
        `Existem ${unresolvedConflicts.length} conflito(s) de conciliação sem decisão. Escolha uma ação para cada conflito antes de confirmar.`,
      );
    }

    return this.repository.commitJobAtomic({
      job,
      resolutionsByItemId,
      ctx,
    });
  }
}

export const ingestionService = new IngestionService();
