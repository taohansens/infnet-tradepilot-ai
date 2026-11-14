import { Prisma } from '@prisma/client';
import {
  MARKET_TYPES,
  TRADE_SIDES,
  toDecimal,
  toNumeric4String,
  type CreateManualTradeRequest,
  type MarketType,
  type TaxSilo,
  type TradeDto,
  type TradeSide,
} from '@tradepilot/shared';
import { getRequiredRlsContext, isValidUuid } from '../db/rlsContext.js';
import { runInRlsTransaction } from '../db/prismaRls.js';
import {
  auditService,
  type AuditLogRepository,
} from './auditService.js';

/**
 * Serviço do Diário de Trade: listagem, cadastro manual com cálculo determinístico
 * de resultado líquido, contextualização operacional e registro psico-emocional.
 *
 * @spec SPEC-10
 * @spec SPEC-12
 * @spec SPEC-13
 * @spec SPEC-04
 * @rf RF-M1-1
 * @rf RF-M1-3
 * @rf RF-M1-4
 * @rnf RNF-1
 * @rnf RNF-11
 * @rnf RNF-20
 * @rnf RNF-30
 */

export class TradesServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'TradesServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function pointValueForMarket(marketType: MarketType): string {
  if (marketType === 'WIN') return '0.2000';
  if (marketType === 'WDO') return '10.0000';
  return '1.0000';
}

function classifyTaxSilo(entryAt: Date, exitAt: Date): TaxSilo {
  const brtEntry = new Date(entryAt.getTime() - 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const brtExit = new Date(exitAt.getTime() - 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return brtEntry === brtExit ? 'DAY_TRADE' : 'SWING_TRADE';
}

function mapTradeRowToDto(row: {
  id: string;
  ticker: string;
  marketType: string;
  side: string;
  taxSilo: string;
  source: string;
  isDemo: boolean;
  entryAt: Date;
  exitAt: Date;
  qty: Prisma.Decimal;
  entryPrice: Prisma.Decimal;
  exitPrice: Prisma.Decimal;
  stopPrice: Prisma.Decimal | null;
  targetPrice: Prisma.Decimal | null;
  fees: Prisma.Decimal;
  irrf: Prisma.Decimal;
  grossPnl: Prisma.Decimal;
  netPnl: Prisma.Decimal;
  pnlPct: Prisma.Decimal | null;
  broker: string | null;
  setupName: string | null;
  followedPlan: boolean | null;
  entryReason: string | null;
  exitReason: string | null;
  notes: string | null;
  preConfidence: number | null;
  preAnxiety: number | null;
  postTags: string[];
  emotionalNote: string | null;
}): TradeDto {
  return {
    id: row.id,
    ticker: row.ticker,
    market_type: row.marketType as MarketType,
    side: row.side as TradeSide,
    tax_silo: row.taxSilo as TaxSilo,
    source: row.source,
    is_demo: row.isDemo,
    entry_at: row.entryAt.toISOString(),
    exit_at: row.exitAt.toISOString(),
    qty: toNumeric4String(row.qty.toString()),
    entry_price: toNumeric4String(row.entryPrice.toString()),
    exit_price: toNumeric4String(row.exitPrice.toString()),
    stop_price: row.stopPrice ? toNumeric4String(row.stopPrice.toString()) : null,
    target_price: row.targetPrice ? toNumeric4String(row.targetPrice.toString()) : null,
    fees: toNumeric4String(row.fees.toString()),
    irrf: toNumeric4String(row.irrf.toString()),
    gross_pnl: toNumeric4String(row.grossPnl.toString()),
    net_pnl: toNumeric4String(row.netPnl.toString()),
    pnl_pct: row.pnlPct ? toNumeric4String(row.pnlPct.toString()) : null,
    broker: row.broker,
    setup_name: row.setupName,
    followed_plan: row.followedPlan,
    entry_reason: row.entryReason,
    exit_reason: row.exitReason,
    notes: row.notes,
    pre_confidence: row.preConfidence,
    pre_anxiety: row.preAnxiety,
    post_tags: row.postTags,
    emotional_note: row.emotionalNote,
  };
}

export class TradesService {
  public async listTrades(filters: {
    from?: string;
    to?: string;
    limit?: number;
  } = {}): Promise<TradeDto[]> {
    const take = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    return runInRlsTransaction(async (tx) => {
      const exitAtFilter: { gte?: Date; lte?: Date } = {};
      if (filters.from) {
        const d = new Date(filters.from);
        if (!Number.isNaN(d.getTime())) exitAtFilter.gte = d;
      }
      if (filters.to) {
        const d = new Date(filters.to);
        if (!Number.isNaN(d.getTime())) exitAtFilter.lte = d;
      }

      const rows = await tx.trade.findMany({
        where:
          exitAtFilter.gte || exitAtFilter.lte ? { exitAt: exitAtFilter } : undefined,
        orderBy: { exitAt: 'desc' },
        take,
      });

      return rows.map(mapTradeRowToDto);
    });
  }

  public async createManualTrade(input: CreateManualTradeRequest): Promise<TradeDto> {
    const ctx = getRequiredRlsContext();
    const ticker = String(input.ticker ?? '').trim().toUpperCase();
    if (!ticker) {
      throw new TradesServiceError(400, 'INVALID_TICKER', 'Informe o código do ativo (ex.: WINZ26, PETR4).');
    }

    if (!MARKET_TYPES.includes(input.market_type)) {
      throw new TradesServiceError(400, 'INVALID_MARKET_TYPE', 'Tipo de mercado inválido.');
    }

    if (!TRADE_SIDES.includes(input.side)) {
      throw new TradesServiceError(400, 'INVALID_SIDE', 'Direção da operação inválida (use LONG ou SHORT).');
    }

    const entryAt = new Date(input.entry_at);
    const exitAt = new Date(input.exit_at);
    if (Number.isNaN(entryAt.getTime()) || Number.isNaN(exitAt.getTime()) || exitAt < entryAt) {
      throw new TradesServiceError(400, 'INVALID_TIMESTAMPS', 'Horário de saída deve ser igual ou posterior à entrada.');
    }

    const qtyDec = toDecimal(String(input.qty));
    const entryDec = toDecimal(String(input.entry_price));
    const exitDec = toDecimal(String(input.exit_price));
    const feesDec = input.fees ? toDecimal(String(input.fees)) : toDecimal('0');
    const irrfDec = input.irrf ? toDecimal(String(input.irrf)) : toDecimal('0');

    if (qtyDec.lte(0)) {
      throw new TradesServiceError(400, 'INVALID_QTY', 'A quantidade deve ser maior que zero.');
    }

    const pointVal = toDecimal(pointValueForMarket(input.market_type));
    const priceDiff = input.side === 'LONG' ? exitDec.minus(entryDec) : entryDec.minus(exitDec);
    const grossPnlDec = priceDiff.mul(qtyDec).mul(pointVal);
    const netPnlDec = grossPnlDec.minus(feesDec).minus(irrfDec);
    const notional = entryDec.mul(qtyDec).mul(pointVal);
    const pnlPctDec = notional.gt(0) ? netPnlDec.div(notional).mul('100') : toDecimal('0');

    return runInRlsTransaction(async (tx) => {
      const created = await tx.trade.create({
        data: {
          userId: ctx.userId,
          ticker,
          marketType: input.market_type,
          side: input.side,
          taxSilo: classifyTaxSilo(entryAt, exitAt),
          source: 'MANUAL',
          isDemo: false,
          entryAt,
          exitAt,
          qty: new Prisma.Decimal(toNumeric4String(qtyDec)),
          entryPrice: new Prisma.Decimal(toNumeric4String(entryDec)),
          exitPrice: new Prisma.Decimal(toNumeric4String(exitDec)),
          stopPrice: input.stop_price
            ? new Prisma.Decimal(toNumeric4String(String(input.stop_price)))
            : null,
          targetPrice: input.target_price
            ? new Prisma.Decimal(toNumeric4String(String(input.target_price)))
            : null,
          fees: new Prisma.Decimal(toNumeric4String(feesDec)),
          irrf: new Prisma.Decimal(toNumeric4String(irrfDec)),
          grossPnl: new Prisma.Decimal(toNumeric4String(grossPnlDec)),
          netPnl: new Prisma.Decimal(toNumeric4String(netPnlDec)),
          pnlPct: new Prisma.Decimal(toNumeric4String(pnlPctDec)),
          broker: input.broker?.trim() || null,
          setupName: input.setup_name?.trim() || null,
          followedPlan:
            typeof input.followed_plan === 'boolean' ? input.followed_plan : null,
          notes: input.notes?.trim() || null,
        },
      });

      await auditService.recordAuditEvent(
        {
          action: 'TRADE_MANUAL_CREATE',
          entityType: 'TRADE',
          entityId: created.id,
          userId: ctx.userId,
          actorId: ctx.userId,
          requestId: ctx.requestId,
          ipHash: ctx.ipHash,
          beforeSnapshot: null,
          afterSnapshot: {
            ticker: created.ticker,
            side: created.side,
            qty: toNumeric4String(qtyDec),
            entry_price: toNumeric4String(entryDec),
            exit_price: toNumeric4String(exitDec),
            net_pnl: toNumeric4String(netPnlDec),
          },
        },
        tx as unknown as AuditLogRepository,
      );

      return mapTradeRowToDto(created);
    });
  }

  public async updateTradeContext(
    tradeId: string,
    payload: {
      setup_name?: string;
      followed_plan?: boolean;
      entry_reason?: string;
      exit_reason?: string;
      notes?: string;
      pre_confidence?: number;
      pre_anxiety?: number;
      post_tags?: string[];
      emotional_note?: string;
    },
  ): Promise<TradeDto> {
    const ctx = getRequiredRlsContext();
    if (!isValidUuid(tradeId)) {
      throw new TradesServiceError(400, 'INVALID_TRADE_ID', 'Identificador de operação inválido.');
    }

    return runInRlsTransaction(async (tx) => {
      const existing = await tx.trade.findUnique({ where: { id: tradeId } });
      if (!existing) {
        throw new TradesServiceError(404, 'TRADE_NOT_FOUND', 'Operação não encontrada.');
      }

      const updated = await tx.trade.update({
        where: { id: tradeId },
        data: {
          setupName: payload.setup_name ?? existing.setupName,
          followedPlan:
            typeof payload.followed_plan === 'boolean'
              ? payload.followed_plan
              : existing.followedPlan,
          entryReason: payload.entry_reason ?? existing.entryReason,
          exitReason: payload.exit_reason ?? existing.exitReason,
          notes: payload.notes ?? existing.notes,
          preConfidence: payload.pre_confidence ?? existing.preConfidence,
          preAnxiety: payload.pre_anxiety ?? existing.preAnxiety,
          postTags: Array.isArray(payload.post_tags)
            ? payload.post_tags
            : existing.postTags,
          emotionalNote: payload.emotional_note ?? existing.emotionalNote,
        },
      });

      await auditService.recordAuditEvent(
        {
          action: 'TRADE_EDIT',
          entityType: 'TRADE',
          entityId: updated.id,
          userId: ctx.userId,
          actorId: ctx.userId,
          requestId: ctx.requestId,
          ipHash: ctx.ipHash,
          beforeSnapshot: {
            setup_name: existing.setupName,
            followed_plan: existing.followedPlan,
          },
          afterSnapshot: {
            setup_name: updated.setupName,
            followed_plan: updated.followedPlan,
          },
        },
        tx as unknown as AuditLogRepository,
      );

      return mapTradeRowToDto(updated);
    });
  }
}

export const tradesService = new TradesService();
