import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  computeTradeDedupHash,
  toDecimal,
  toNumeric4String,
} from '@tradepilot/shared';
import { createAuthRlsMiddleware } from '../src/apps/api/src/middlewares/authRls.js';
import { getRequiredRlsContext } from '../src/apps/api/src/db/rlsContext.js';
import {
  IngestionService,
  type IngestionRepository,
  type StoredIngestionJob,
} from '../src/apps/api/src/services/ingestionService.js';
import { createIngestionRouter } from '../src/apps/api/src/routes/ingestionRoutes.js';
import {
  AuditService,
  type AuditLogRecord,
  type AuditLogRepository,
} from '../src/apps/api/src/services/auditService.js';

/**
 * Suíte Gherkin de Ingestão Assíncrona, Deduplicação Idempotente e Conciliação Atômica.
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
 * @rnf RNF-30
 */

const TEST_JWT_SECRET = 'segredo-testes-ingestao-dedup-conciliacao-32';
const USER_ID = '11111111-1111-4111-8111-111111111111';

interface InMemoryTrade {
  id: string;
  userId: string;
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
  dedupHash: string;
}

function createTestIngestionApp() {
  const trades = new Map<string, InMemoryTrade>();
  const jobs = new Map<string, StoredIngestionJob>();
  const auditLogs: AuditLogRecord[] = [];
  const auditService = new AuditService();

  const auditRepo: AuditLogRepository = {
    auditLog: {
      async create({ data }) {
        const record: AuditLogRecord = {
          id: randomUUID(),
          userId: data.userId,
          actorId: data.actorId,
          action: data.action,
          entityType: data.entityType,
          entityId: data.entityId,
          beforeSnapshot: data.beforeSnapshot as AuditLogRecord['beforeSnapshot'],
          afterSnapshot: data.afterSnapshot as AuditLogRecord['afterSnapshot'],
          requestId: data.requestId,
          ipHash: data.ipHash,
          createdAtUtc: new Date(),
        };
        auditLogs.push(record);
        return record;
      },
      async findMany() {
        return [...auditLogs];
      },
    },
  };

  const repo: IngestionRepository = {
    async createQueuedJob(params) {
      const id = randomUUID();
      jobs.set(id, {
        id,
        userId: params.userId,
        sourceHint: params.sourceHint,
        fileName: params.fileName,
        fileSha256: params.fileSha256,
        status: 'QUEUED',
        totalRows: 0,
        processedRows: 0,
        conflictCount: 0,
        errorMessagePtbr: null,
        createdAt: new Date(),
        completedAt: null,
        stagingItems: [],
      });
      return { id, fileName: params.fileName };
    },
    async markJobProcessing(jobId) {
      const job = jobs.get(jobId);
      if (job) job.status = 'PROCESSING';
    },
    async findExistingTradesByHashes(userId, hashes) {
      const hashSet = new Set(hashes);
      return [...trades.values()]
        .filter((t) => t.userId === userId && hashSet.has(t.dedupHash))
        .map((t) => ({
          id: t.id,
          dedupHash: t.dedupHash,
          fees: t.fees,
          irrf: t.irrf,
        }));
    },
    async saveStagingAndMarkReview({ jobId, userId, rows }) {
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = 'AWAITING_REVIEW';
      job.totalRows = rows.length;
      job.processedRows = rows.length;
      job.conflictCount = rows.filter((r) => r.dedupStatus === 'CONFLICT').length;
      job.stagingItems = rows.map((r) => {
        const matched = r.matchedTradeId ? trades.get(r.matchedTradeId) ?? null : null;
        return {
          id: randomUUID(),
          jobId,
          userId,
          rowNumber: r.rowNumber,
          broker: r.broker,
          tradeDate: r.tradeDate,
          executedAt: r.executedAt,
          ticker: r.ticker,
          marketType: r.marketType,
          side: r.side,
          qty: r.qty,
          price: r.price,
          fees: r.fees,
          irrf: r.irrf,
          dedupHash: r.dedupHash,
          dedupStatus: r.dedupStatus,
          matchedTradeId: r.matchedTradeId,
          diffFields: r.diffFields,
          resolutionAction: null,
          matchedTrade: matched,
        };
      });
    },
    async markJobFailed(jobId, errorMessagePtBr) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'FAILED';
        job.errorMessagePtbr = errorMessagePtBr;
        job.completedAt = new Date();
      }
    },
    async getJobWithItems(jobId) {
      const ctx = getRequiredRlsContext();
      const job = jobs.get(jobId);
      if (!job || job.userId !== ctx.userId) return null;
      return job;
    },
    async commitJobAtomic({ job, resolutionsByItemId, ctx }) {
      let inserted = 0;
      let merged = 0;
      let overwritten = 0;
      let ignored = 0;

      for (const item of job.stagingItems) {
        const explicitAction = resolutionsByItemId.get(item.id);
        if (item.dedupStatus === 'NEW' && explicitAction !== 'IGNORE') {
          const tradeId = randomUUID();
          const net = toNumeric4String(
            toDecimal(item.fees).plus(toDecimal(item.irrf)).negated(),
          );
          trades.set(tradeId, {
            id: tradeId,
            userId: ctx.userId,
            ticker: item.ticker,
            side: item.side === 'SELL' ? 'SHORT' : 'LONG',
            qty: item.qty,
            entryPrice: item.price,
            exitPrice: item.price,
            fees: item.fees,
            irrf: item.irrf,
            grossPnl: '0.0000',
            netPnl: net,
            source: job.sourceHint,
            broker: item.broker,
            dedupHash: item.dedupHash,
          });
          inserted += 1;
          continue;
        }

        const action =
          explicitAction ??
          (item.dedupStatus === 'EXACT_DUPLICATE' ? 'IGNORE' : 'MERGE_COSTS');

        if (action === 'IGNORE' || !item.matchedTradeId) {
          ignored += 1;
          continue;
        }

        const existing = trades.get(item.matchedTradeId);
        if (!existing) {
          ignored += 1;
          continue;
        }

        const before = {
          fees: existing.fees,
          irrf: existing.irrf,
          gross_pnl: existing.grossPnl,
          net_pnl: existing.netPnl,
        };

        const recalculatedNet = toNumeric4String(
          toDecimal(existing.grossPnl)
            .minus(toDecimal(item.fees))
            .minus(toDecimal(item.irrf)),
        );

        existing.fees = item.fees;
        existing.irrf = item.irrf;
        existing.netPnl = recalculatedNet;

        if (action === 'OVERWRITE') {
          existing.entryPrice = item.price;
          existing.exitPrice = item.price;
          existing.source = job.sourceHint;
          overwritten += 1;
        } else {
          merged += 1;
        }

        await auditService.recordAuditEvent(
          {
            action: 'CONCILIATION_MERGE',
            entityType: 'TRADE',
            entityId: existing.id,
            userId: ctx.userId,
            actorId: ctx.userId,
            beforeSnapshot: before,
            afterSnapshot: {
              fees: existing.fees,
              irrf: existing.irrf,
              gross_pnl: existing.grossPnl,
              net_pnl: existing.netPnl,
            },
          },
          auditRepo,
        );
      }

      job.status = 'COMMITTED';
      job.completedAt = new Date();
      return { job_id: job.id, inserted, merged, overwritten, ignored };
    },
  };

  const pendingWorkers: Promise<void>[] = [];
  const service = new IngestionService({
    repository: repo,
    scheduleWorker: (task) => {
      pendingWorkers.push(task());
    },
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/ingestion',
    createAuthRlsMiddleware({ jwtSecret: TEST_JWT_SECRET }),
    createIngestionRouter(service),
  );

  const token = jwt.sign(
    { sub: USER_ID, email: 'rafael@exemplo.com', plan_status: 'active' },
    TEST_JWT_SECRET,
    {
      issuer: 'tradepilot-ai',
      audience: 'tradepilot-ai-web',
      expiresIn: 900,
    },
  );

  return {
    app,
    token,
    trades,
    auditLogs,
    flushWorkers: async () => {
      await Promise.all(pendingWorkers.splice(0, pendingWorkers.length));
    },
  };
}

describe('[SPEC-06][SPEC-08][SPEC-09] Ingestão Assíncrona, Deduplicação e Conciliação', () => {
  it('[SPEC-06] Dado um arquivo CSV válido do Profit com 300 linhas, Quando enviado via POST /api/v1/ingestion/jobs, Então retorna 202 Accepted com job_id e conclui staging em <= 30s (RNF-3)', async () => {
    const { app, token, flushWorkers } = createTestIngestionApp();

    const lines = ['Ativo;Abertura;Lado;Qtd;Preço Médio;Taxas;IRRF'];
    for (let i = 0; i < 300; i += 1) {
      const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
      const min = String(i % 60).padStart(2, '0');
      lines.push(`WINZ26;09/10/2026 ${hour}:${min}:00;C;1;${131000 + i},00;1,20;0,00`);
    }

    const start = performance.now();
    const res = await request(app)
      .post('/api/v1/ingestion/jobs')
      .set('Authorization', `Bearer ${token}`)
      .field('source_hint', 'PROFIT_CSV')
      .attach('file', Buffer.from(lines.join('\n'), 'utf8'), 'profit_300.csv');

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('queued');
    expect(res.body.job_id).toBeTruthy();

    await flushWorkers();
    const elapsedMs = performance.now() - start;

    const detail = await request(app)
      .get(`/api/v1/ingestion/jobs/${res.body.job_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.status).toBe('AWAITING_REVIEW');
    expect(detail.body.total_rows).toBe(300);
    expect(detail.body.summary.new_count).toBe(300);
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it('[SPEC-06] Dado um arquivo CSV com valor inválido na linha 14, Quando processado pelo worker, Então falha com mensagem legível em PT-BR indicando a linha', async () => {
    const { app, token, flushWorkers } = createTestIngestionApp();

    const lines = ['Data;Lado;Ativo;Quantidade;Preço'];
    for (let i = 2; i <= 13; i += 1) {
      lines.push(`09/10/2026 10:${String(i).padStart(2, '0')}:00;C;PETR4;100;38,50`);
    }
    lines.push('09/10/2026 10:14:00;C;PETR4;100;INVALIDO');

    const res = await request(app)
      .post('/api/v1/ingestion/jobs')
      .set('Authorization', `Bearer ${token}`)
      .field('source_hint', 'B3_CSV')
      .attach('file', Buffer.from(lines.join('\n'), 'utf8'), 'extrato_quebrado.csv')
      .expect(202);

    await flushWorkers();

    const detail = await request(app)
      .get(`/api/v1/ingestion/jobs/${res.body.job_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.status).toBe('FAILED');
    expect(detail.body.error_message_ptbr).toContain(
      'Inconsistência no Extrato da Corretora na linha 14',
    );
  });

  it('[SPEC-08] Deve gerar hash SHA-256 idempotente e marcar CONFLICT quando taxas/IRRF divergem da operação existente', async () => {
    const { app, token, trades, flushWorkers } = createTestIngestionApp();

    const existingId = randomUUID();
    const executedAt = new Date('2026-10-09T10:05:00-03:00');
    const dedupHash = computeTradeDedupHash({
      userId: USER_ID,
      ticker: 'WDOX26',
      executedAt,
      side: 'BUY',
      qty: '2',
      price: '5450.50',
    });

    // Dado uma operação já importada via extrato B3 (sem taxas da corretora)
    trades.set(existingId, {
      id: existingId,
      userId: USER_ID,
      ticker: 'WDOX26',
      side: 'LONG',
      qty: '2.0000',
      entryPrice: '5450.5000',
      exitPrice: '5450.5000',
      fees: '0.0000',
      irrf: '0.0000',
      grossPnl: '250.0000',
      netPnl: '250.0000',
      source: 'B3_CSV',
      broker: 'B3',
      dedupHash,
    });

    // Quando reimportada com taxas e IRRF da corretora
    const csv = [
      'Data;Lado;Ativo;Quantidade;Preço;Taxas;IRRF',
      '09/10/2026 10:05:45;Compra;WDOX26;2;5450,50;2,40;1,25',
    ].join('\n');

    const upload = await request(app)
      .post('/api/v1/ingestion/jobs')
      .set('Authorization', `Bearer ${token}`)
      .field('source_hint', 'PROFIT_CSV')
      .attach('file', Buffer.from(csv, 'utf8'), 'nota_taxas.csv')
      .expect(202);

    await flushWorkers();

    const detail = await request(app)
      .get(`/api/v1/ingestion/jobs/${upload.body.job_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Então o item é marcado como CONFLICT apontando fees e irrf
    expect(detail.body.summary.conflict_count).toBe(1);
    expect(detail.body.items[0]).toMatchObject({
      dedup_status: 'CONFLICT',
      matched_trade_id: existingId,
      diff_fields: ['fees', 'irrf'],
    });
  });

  it('[SPEC-09] Dado 2 conflitos em staging, Quando o usuário escolher MERGE_COSTS para ambos e confirmar, Então incorpora taxas/IRRF atomicamente sem duplicar resultado bruto e grava na audit_logs', async () => {
    const { app, token, trades, auditLogs, flushWorkers } =
      createTestIngestionApp();

    const t1Id = randomUUID();
    const t2Id = randomUUID();

    const h1 = computeTradeDedupHash({
      userId: USER_ID,
      ticker: 'WDOX26',
      executedAt: new Date('2026-10-09T10:05:00-03:00'),
      side: 'BUY',
      qty: '2',
      price: '5450.50',
    });
    const h2 = computeTradeDedupHash({
      userId: USER_ID,
      ticker: 'WINZ26',
      executedAt: new Date('2026-10-09T10:20:00-03:00'),
      side: 'SELL',
      qty: '5',
      price: '131200.00',
    });

    trades.set(t1Id, {
      id: t1Id,
      userId: USER_ID,
      ticker: 'WDOX26',
      side: 'LONG',
      qty: '2.0000',
      entryPrice: '5450.5000',
      exitPrice: '5450.5000',
      fees: '0.0000',
      irrf: '0.0000',
      grossPnl: '300.0000',
      netPnl: '300.0000',
      source: 'B3_CSV',
      broker: 'B3',
      dedupHash: h1,
    });
    trades.set(t2Id, {
      id: t2Id,
      userId: USER_ID,
      ticker: 'WINZ26',
      side: 'SHORT',
      qty: '5.0000',
      entryPrice: '131200.0000',
      exitPrice: '131200.0000',
      fees: '0.0000',
      irrf: '0.0000',
      grossPnl: '150.0000',
      netPnl: '150.0000',
      source: 'B3_CSV',
      broker: 'B3',
      dedupHash: h2,
    });

    const csv = [
      'Data;Lado;Ativo;Quantidade;Preço;Taxas;IRRF',
      '09/10/2026 10:05:00;Compra;WDOX26;2;5450,50;2,40;3,00',
      '09/10/2026 10:20:00;Venda;WINZ26;5;131200,00;4,50;1,50',
    ].join('\n');

    const upload = await request(app)
      .post('/api/v1/ingestion/jobs')
      .set('Authorization', `Bearer ${token}`)
      .field('source_hint', 'PROFIT_CSV')
      .attach('file', Buffer.from(csv, 'utf8'), 'conciliacao_2.csv')
      .expect(202);

    await flushWorkers();

    const detail = await request(app)
      .get(`/api/v1/ingestion/jobs/${upload.body.job_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const resolutions = detail.body.items.map(
      (i: { staging_item_id: string }) => ({
        staging_item_id: i.staging_item_id,
        action: 'MERGE_COSTS',
      }),
    );

    const commit = await request(app)
      .post(`/api/v1/ingestion/jobs/${upload.body.job_id}/commit`)
      .set('Authorization', `Bearer ${token}`)
      .send({ resolutions })
      .expect(200);

    expect(commit.body).toMatchObject({
      inserted: 0,
      merged: 2,
      overwritten: 0,
      ignored: 0,
    });

    // Resultado bruto preservado (sem duplicar), custos incorporados com Decimal exato
    expect(trades.size).toBe(2);
    expect(trades.get(t1Id)?.grossPnl).toBe('300.0000');
    expect(trades.get(t1Id)?.fees).toBe('2.4000');
    expect(trades.get(t1Id)?.irrf).toBe('3.0000');
    expect(trades.get(t1Id)?.netPnl).toBe('294.6000');

    expect(trades.get(t2Id)?.grossPnl).toBe('150.0000');
    expect(trades.get(t2Id)?.netPnl).toBe('144.0000');

    // Trilha de auditoria imutável gravada (SPEC-04, RNF-30)
    expect(auditLogs).toHaveLength(2);
    expect(auditLogs.every((l) => l.action === 'CONCILIATION_MERGE')).toBe(true);
  });
});
