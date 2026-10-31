import * as XLSX from 'xlsx';
import { describe, expect, it, vi } from 'vitest';
import { computeTradeDedupHash } from '@tradepilot/shared';
import {
  IngestionParseError,
  parseIngestionFile,
} from '../services/ingestionParser.js';
import { classifyStagingRows } from '../services/deduplicationEngine.js';
import {
  IngestionService,
  IngestionServiceError,
  type IngestionRepository,
  type StoredIngestionJob,
} from '../services/ingestionService.js';
import { runWithRlsContext } from '../db/rlsContext.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const TRADE_ID = '33333333-3333-4333-8333-333333333333';
const STAGING_NEW_ID = '44444444-4444-4444-8444-444444444444';
const STAGING_CONFLICT_ID = '55555555-5555-4555-8555-555555555555';

/**
 * Testes automatizados da Sprint 2 (SPEC-06, SPEC-08, SPEC-09):
 * - Parser CSV/XLSX (Extrato B3 e Profit) com erros em linguagem de negócio PT-BR
 * - Motor de Deduplicação SHA-256 (NEW, EXACT_DUPLICATE, CONFLICT)
 * - Ingestão assíncrona em staging (ADR-01) e commit atômico (IGNORE, OVERWRITE, MERGE_COSTS)
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
describe('IngestionParser (SPEC-06 — B3 CSV, Profit CSV e XLSX)', () => {
  it('faz parsing exato de Extrato B3 CSV com separador ; e valores em PT-BR', () => {
    const csv = [
      'Data do Negócio;Tipo de Movimentação;Código de Negociação;Quantidade;Preço;Instituição;Taxas;IRRF',
      '09/10/2026 10:05:00;Compra;WDOX26;2;R$ 5.450,50;XP;2,40;0,00',
      '09/10/2026 10:22:00;Venda;PETR4;100;R$ 38,25;Clear;1,15;0,19',
    ].join('\n');

    const rows = parseIngestionFile({
      fileBuffer: Buffer.from(csv, 'utf8'),
      fileName: 'negociacao_b3.csv',
      sourceHint: 'B3_CSV',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      ticker: 'WDOX26',
      marketType: 'WDO',
      side: 'BUY',
      qty: '2.0000',
      price: '5450.5000',
      fees: '2.4000',
      irrf: '0.0000',
      broker: 'XP',
    });
    expect(rows[1]).toMatchObject({
      rowNumber: 3,
      ticker: 'PETR4',
      marketType: 'ACOES',
      side: 'SELL',
      qty: '100.0000',
      price: '38.2500',
      fees: '1.1500',
      irrf: '0.1900',
    });
  });

  it('faz parsing de planilha XLSX real do Profit sem float binário', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Ativo', 'Abertura', 'Lado', 'Qtd', 'Preço Médio', 'Taxas'],
      ['WINZ26', '09/10/2026 10:10:00', 'C', '5', '131200,00', '3,50'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Ordens');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const rows = parseIngestionFile({
      fileBuffer: buffer,
      fileName: 'ordens_profit.xlsx',
      sourceHint: 'PROFIT_CSV',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticker: 'WINZ26',
      marketType: 'WIN',
      side: 'BUY',
      qty: '5.0000',
      price: '131200.0000',
      fees: '3.5000',
      broker: 'Profit',
    });
  });

  it('retorna mensagem amigável de negócio indicando a linha divergente (sem jargão técnico)', () => {
    const invalidCsv = [
      'Data;Lado;Ativo;Quantidade;Preço',
      '09/10/2026;C;WINZ26;2;131200',
      '09/10/2026;C;WINZ26;2;VALOR_QUEBRADO',
    ].join('\n');

    expect(() =>
      parseIngestionFile({
        fileBuffer: Buffer.from(invalidCsv, 'utf8'),
        fileName: 'profit_invalido.csv',
        sourceHint: 'PROFIT_CSV',
      }),
    ).toThrow(IngestionParseError);

    try {
      parseIngestionFile({
        fileBuffer: Buffer.from(invalidCsv, 'utf8'),
        fileName: 'profit_invalido.csv',
        sourceHint: 'PROFIT_CSV',
      });
    } catch (err) {
      expect((err as Error).message).toContain(
        'Inconsistência no Extrato da Corretora na linha 3',
      );
    }
  });

  it('processa 300 linhas muito abaixo do SLA de 30s (RNF-3)', () => {
    const lines = ['Data;Lado;Ativo;Quantidade;Preço;Taxas;IRRF'];
    for (let i = 0; i < 300; i += 1) {
      const minute = String(i % 60).padStart(2, '0');
      const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
      lines.push(`09/10/2026 ${hour}:${minute}:00;C;WINZ26;1;131${200 + i};1,20;0,00`);
    }

    const start = performance.now();
    const parsed = parseIngestionFile({
      fileBuffer: Buffer.from(lines.join('\n'), 'utf8'),
      fileName: 'lote_300.csv',
      sourceHint: 'PROFIT_CSV',
    });
    const classified = classifyStagingRows({
      userId: USER_ID,
      rows: parsed,
      existingTrades: [],
    });
    const elapsedMs = performance.now() - start;

    expect(classified).toHaveLength(300);
    expect(elapsedMs).toBeLessThan(30_000);
  });
});

describe('DeduplicationEngine (SPEC-08 — NEW, EXACT_DUPLICATE, CONFLICT)', () => {
  it('classifica corretamente NEW, EXACT_DUPLICATE e CONFLICT (divergência de fees/irrf)', () => {
    const csv = [
      'Data;Lado;Ativo;Quantidade;Preço;Taxas;IRRF',
      // Igual ao trade existente, mas com taxas/IRRF diferentes -> CONFLICT
      '09/10/2026 10:05:12;Compra;WDOX26;2;5450,50;2,40;0,50',
      // Igual ao trade existente e mesmos custos -> EXACT_DUPLICATE
      '09/10/2026 10:15:00;Venda;PETR4;100;38,25;1,00;0,00',
      // Nova operação -> NEW
      '09/10/2026 11:00:00;Compra;VALE3;50;62,10;0,90;0,00',
    ].join('\n');

    const rows = parseIngestionFile({
      fileBuffer: Buffer.from(csv, 'utf8'),
      fileName: 'nota_vs_b3.csv',
      sourceHint: 'B3_CSV',
    });

    const hashWdo = computeTradeDedupHash({
      userId: USER_ID,
      ticker: 'WDOX26',
      executedAt: rows[0]!.executedAt,
      side: 'BUY',
      qty: '2',
      price: '5450.50',
    });

    const hashPetr = computeTradeDedupHash({
      userId: USER_ID,
      ticker: 'PETR4',
      executedAt: rows[1]!.executedAt,
      side: 'SELL',
      qty: '100',
      price: '38.25',
    });

    const classified = classifyStagingRows({
      userId: USER_ID,
      rows,
      existingTrades: [
        { id: TRADE_ID, dedupHash: hashWdo, fees: '0.0000', irrf: '0.0000' },
        {
          id: '66666666-6666-4666-8666-666666666666',
          dedupHash: hashPetr,
          fees: '1.0000',
          irrf: '0.0000',
        },
      ],
    });

    expect(classified[0]).toMatchObject({
      dedupStatus: 'CONFLICT',
      matchedTradeId: TRADE_ID,
      diffFields: ['fees', 'irrf'],
      recommendedAction: 'MERGE_COSTS',
    });
    expect(classified[1]).toMatchObject({
      dedupStatus: 'EXACT_DUPLICATE',
      diffFields: [],
      recommendedAction: 'IGNORE',
    });
    expect(classified[2]).toMatchObject({
      dedupStatus: 'NEW',
      matchedTradeId: null,
      diffFields: [],
    });
  });
});

describe('IngestionService (SPEC-06 & SPEC-09 — 202 Assíncrono + Commit Atômico)', () => {
  it('enfileira job (202 queued), executa worker em staging e exige resolução para conflitos no commit', async () => {
    let scheduledTask: (() => Promise<void>) | undefined;
    let storedJob: StoredIngestionJob | null = null;

    const commitSpy = vi.fn(async ({ resolutionsByItemId }) => {
      expect(resolutionsByItemId.get(STAGING_CONFLICT_ID)).toBe('MERGE_COSTS');
      return {
        job_id: JOB_ID,
        inserted: 1,
        merged: 1,
        overwritten: 0,
        ignored: 0,
      };
    });

    const repo: IngestionRepository = {
      async createQueuedJob(params) {
        storedJob = {
          id: JOB_ID,
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
        };
        return { id: JOB_ID, fileName: params.fileName };
      },
      async markJobProcessing() {
        if (storedJob) storedJob.status = 'PROCESSING';
      },
      async findExistingTradesByHashes(_userId, hashes) {
        return hashes[0]
          ? [{ id: TRADE_ID, dedupHash: hashes[0], fees: '0.0000', irrf: '0.0000' }]
          : [];
      },
      async saveStagingAndMarkReview({ rows }) {
        if (!storedJob) return;
        storedJob.status = 'AWAITING_REVIEW';
        storedJob.totalRows = rows.length;
        storedJob.processedRows = rows.length;
        storedJob.conflictCount = rows.filter(
          (r) => r.dedupStatus === 'CONFLICT',
        ).length;
        storedJob.stagingItems = rows.map((r, idx) => ({
          id: idx === 0 ? STAGING_CONFLICT_ID : STAGING_NEW_ID,
          jobId: JOB_ID,
          userId: USER_ID,
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
        }));
      },
      async markJobFailed(_id, msg) {
        if (storedJob) {
          storedJob.status = 'FAILED';
          storedJob.errorMessagePtbr = msg;
        }
      },
      async getJobWithItems() {
        return storedJob;
      },
      commitJobAtomic: commitSpy,
    };

    const service = new IngestionService({
      repository: repo,
      scheduleWorker: (task) => {
        scheduledTask = task;
      },
    });

    const csv = [
      'Data;Lado;Ativo;Quantidade;Preço;Taxas;IRRF',
      '09/10/2026 10:05:00;Compra;WDOX26;2;5450,50;2,40;0,00',
      '09/10/2026 11:00:00;Venda;PETR4;100;38,50;1,10;0,15',
    ].join('\n');

    const queued = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-ing-1' },
      () =>
        service.enqueueIngestionJob({
          fileBuffer: Buffer.from(csv, 'utf8'),
          fileName: 'extrato_b3.csv',
          sourceHint: 'B3_CSV',
        }),
    );

    expect(queued).toEqual({
      job_id: JOB_ID,
      status: 'queued',
      file_name: 'extrato_b3.csv',
    });

    // Executa o worker assíncrono enfileirado
    expect(scheduledTask).toBeDefined();
    await scheduledTask!();

    const detail = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-ing-2' },
      () => service.getJobDetail(JOB_ID),
    );
    expect(detail.status).toBe('AWAITING_REVIEW');
    expect(detail.summary.conflict_count).toBe(1);
    expect(detail.summary.new_count).toBe(1);

    // Sem resolução para o conflito -> rejeita com 400 UNRESOLVED_CONFLICTS
    await expect(
      runWithRlsContext({ userId: USER_ID, requestId: 'req-ing-3' }, () =>
        service.commitJob(JOB_ID, { resolutions: [] }),
      ),
    ).rejects.toThrow(IngestionServiceError);

    // Com resolução MERGE_COSTS -> executa commit atômico
    const committed = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-ing-4' },
      () =>
        service.commitJob(JOB_ID, {
          resolutions: [
            { staging_item_id: STAGING_CONFLICT_ID, action: 'MERGE_COSTS' },
          ],
        }),
    );

    expect(committed).toEqual({
      job_id: JOB_ID,
      inserted: 1,
      merged: 1,
      overwritten: 0,
      ignored: 0,
    });
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });
});
