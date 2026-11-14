import { Decimal } from 'decimal.js';
import {
  formatBrl,
  toDecimal,
  toNumeric4String,
  type AnalyticsBreakdownResponse,
  type AnalyticsSummaryResponse,
  type BreakdownBucketDto,
  type DailyCalendarBucketDto,
  type DeterministicInsightDto,
  type EquityCurveResponse,
  type EquityPointDto,
  type FormulaXRayDto,
} from '@tradepilot/shared';
import { runInRlsTransaction } from '../db/prismaRls.js';

/**
 * Motor Determinístico de Métricas Core, Curva de Capital, Segmentador Multidimensional,
 * Insights Heurísticos e Metadados do Raio-X da Fórmula (`SPEC-14` a `SPEC-17`, `SPEC-20`).
 *
 * Toda a matemática é executada exclusivamente em `Decimal` (zero float binário e zero LLM).
 *
 * @spec SPEC-14
 * @spec SPEC-15
 * @spec SPEC-16
 * @spec SPEC-17
 * @spec SPEC-20
 * @rf RF-M2-1
 * @rf RF-M2-2
 * @rf RF-M2-3
 * @rf RF-M2-4
 * @rnf RNF-11
 * @rnf RNF-19
 * @rnf RNF-20
 * @rnf RNF-28
 * @rnf RNF-29
 */

export interface TradeAnalyticsRow {
  id: string;
  ticker: string;
  setupName: string | null;
  followedPlan: boolean | null;
  exitAt: Date;
  netPnl: string;
}

const WEEKDAY_LABELS_PT = [
  'DOMINGO',
  'SEGUNDA',
  'TERÇA',
  'QUARTA',
  'QUINTA',
  'SEXTA',
  'SÁBADO',
] as const;

function toFixed2(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Calcula métricas core determinísticas e monta o Raio-X da Fórmula (`SPEC-14`, `SPEC-20`).
 *
 * @spec SPEC-14
 * @spec SPEC-20
 * @rf RF-M2-1
 * @rnf RNF-19
 * @rnf RNF-20
 * @rnf RNF-29
 */
export function computeDeterministicSummary(
  trades: TradeAnalyticsRow[],
): AnalyticsSummaryResponse {
  const sorted = [...trades].sort(
    (a, b) => a.exitAt.getTime() - b.exitAt.getTime(),
  );

  const totalTrades = sorted.length;
  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfit = toDecimal('0');
  let grossLoss = toDecimal('0'); // armazenado negativo ou zero
  let totalPnl = toDecimal('0');
  let planFollowedCount = 0;
  let planScoredCount = 0;

  let curWinStreak = 0;
  let maxWinStreak = 0;
  let curLossStreak = 0;
  let maxLossStreak = 0;

  let equity = toDecimal('0');
  let peak = toDecimal('0');
  let maxDrawdown = toDecimal('0');

  for (const t of sorted) {
    const pnl = toDecimal(t.netPnl);
    totalPnl = totalPnl.plus(pnl);
    equity = equity.plus(pnl);

    if (equity.gt(peak)) {
      peak = equity;
    }
    const dd = equity.minus(peak); // <= 0
    if (dd.lt(maxDrawdown)) {
      maxDrawdown = dd;
    }

    if (pnl.gt(0)) {
      winningTrades += 1;
      grossProfit = grossProfit.plus(pnl);
      curWinStreak += 1;
      curLossStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (pnl.lt(0)) {
      losingTrades += 1;
      grossLoss = grossLoss.plus(pnl);
      curLossStreak += 1;
      curWinStreak = 0;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      curWinStreak = 0;
      curLossStreak = 0;
    }

    if (t.followedPlan !== null) {
      planScoredCount += 1;
      if (t.followedPlan) planFollowedCount += 1;
    }
  }

  const winRateDec =
    totalTrades > 0
      ? toDecimal(String(winningTrades)).div(String(totalTrades))
      : toDecimal('0');

  const avgWinDec =
    winningTrades > 0 ? grossProfit.div(String(winningTrades)) : toDecimal('0');

  const avgLossDec =
    losingTrades > 0 ? grossLoss.div(String(losingTrades)) : toDecimal('0');

  const absAvgLoss = avgLossDec.abs();
  const absGrossLoss = grossLoss.abs();

  const payoffDec = absAvgLoss.gt(0) ? avgWinDec.div(absAvgLoss) : null;

  const profitFactorInfinite = grossProfit.gt(0) && absGrossLoss.eq(0);
  const profitFactorDec = absGrossLoss.gt(0)
    ? grossProfit.div(absGrossLoss)
    : null;

  // Expectativa = (win_rate * ganho_medio) - ((1 - win_rate) * |perda_media|)
  const lossRateDec = toDecimal('1').minus(winRateDec);
  const expectancyDec = winRateDec
    .mul(avgWinDec)
    .minus(lossRateDec.mul(absAvgLoss));

  const planAdherenceDec =
    planScoredCount > 0
      ? toDecimal(String(planFollowedCount))
          .div(String(planScoredCount))
          .mul('100')
      : toDecimal('0');

  const winRatePct = winRateDec.mul('100');

  const xray: Record<string, FormulaXRayDto> = {
    win_rate: {
      metric: 'win_rate',
      label: 'Taxa de Acerto (Win Rate)',
      formula: '(Trades Vencedores / Total de Trades) × 100',
      inputs: {
        trades_vencedores: String(winningTrades),
        total_trades: String(totalTrades),
      },
      substitution:
        totalTrades > 0
          ? `(${winningTrades} / ${totalTrades}) × 100 = ${toFixed2(winRatePct)}%`
          : 'Sem operações no período',
      result: `${toFixed2(winRatePct)}%`,
    },
    payoff: {
      metric: 'payoff',
      label: 'Payoff (Ganho Médio / Perda Média)',
      formula: 'Ganho Médio / |Perda Média|',
      inputs: {
        ganho_medio: formatBrl(avgWinDec),
        perda_media: formatBrl(avgLossDec),
      },
      substitution: payoffDec
        ? `${formatBrl(avgWinDec)} / |${formatBrl(avgLossDec)}| = ${toFixed2(payoffDec)}`
        : 'Sem perdas registradas no período',
      result: payoffDec ? toFixed2(payoffDec) : '—',
    },
    profit_factor: {
      metric: 'profit_factor',
      label: 'Fator de Lucro (Profit Factor)',
      formula: 'Lucro Bruto / |Prejuízo Bruto|',
      inputs: {
        lucro_bruto: formatBrl(grossProfit),
        prejuizo_bruto: formatBrl(grossLoss),
      },
      substitution: profitFactorDec
        ? `${formatBrl(grossProfit)} / |${formatBrl(grossLoss)}| = ${toFixed2(profitFactorDec)}`
        : profitFactorInfinite
          ? `${formatBrl(grossProfit)} / R$ 0,00 = Infinito (sem perdas)`
          : 'Sem operações no período',
      result: profitFactorDec
        ? toFixed2(profitFactorDec)
        : profitFactorInfinite
          ? '∞'
          : '—',
    },
    expectancy_brl: {
      metric: 'expectancy_brl',
      label: 'Expectativa Matemática por Trade',
      formula: '(Win Rate × Ganho Médio) - ((1 - Win Rate) × |Perda Média|)',
      inputs: {
        win_rate: toFixed2(winRateDec),
        ganho_medio: formatBrl(avgWinDec),
        perda_media: formatBrl(avgLossDec),
      },
      substitution: `(${toFixed2(winRateDec)} × ${formatBrl(avgWinDec)}) - (${toFixed2(lossRateDec)} × ${formatBrl(absAvgLoss)}) = ${formatBrl(expectancyDec)}`,
      result: formatBrl(expectancyDec),
    },
    max_drawdown_brl: {
      metric: 'max_drawdown_brl',
      label: 'Drawdown Máximo (Pico ao Vale)',
      formula: 'min(Capital Acumulado(t) - Pico Histórico(t))',
      inputs: {
        pico_maximo: formatBrl(peak),
        resultado_liquido_atual: formatBrl(totalPnl),
      },
      substitution: `Maior queda pico-a-vale na curva cronológica = ${formatBrl(maxDrawdown)}`,
      result: formatBrl(maxDrawdown),
    },
  };

  return {
    total_trades: totalTrades,
    winning_trades: winningTrades,
    losing_trades: losingTrades,
    win_rate: winRateDec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    payoff: payoffDec ? toFixed2(payoffDec) : null,
    profit_factor: profitFactorDec ? toFixed2(profitFactorDec) : null,
    profit_factor_infinite: profitFactorInfinite,
    expectancy_brl: toFixed2(expectancyDec),
    total_pnl_brl: toFixed2(totalPnl),
    gross_profit_brl: toFixed2(grossProfit),
    gross_loss_brl: toFixed2(grossLoss),
    avg_win_brl: toFixed2(avgWinDec),
    avg_loss_brl: toFixed2(avgLossDec),
    max_win_streak: maxWinStreak,
    max_loss_streak: maxLossStreak,
    max_drawdown_brl: toFixed2(maxDrawdown),
    plan_adherence_pct: toFixed2(planAdherenceDec),
    xray,
  };
}

/**
 * Gera a curva de capital acumulada e a grade diária do calendário operacional (`SPEC-15`, `SPEC-18`).
 *
 * @spec SPEC-15
 * @spec SPEC-18
 * @rf RF-M2-2
 * @rf RF-M8-1
 */
export function computeEquityCurveAndCalendar(
  trades: TradeAnalyticsRow[],
): EquityCurveResponse {
  const sorted = [...trades].sort(
    (a, b) => a.exitAt.getTime() - b.exitAt.getTime(),
  );

  let cumulative = toDecimal('0');
  let peak = toDecimal('0');
  const points: EquityPointDto[] = [];
  const dailyMap = new Map<
    string,
    { tradesCount: number; wins: number; losses: number; pnl: Decimal }
  >();

  for (const t of sorted) {
    const pnl = toDecimal(t.netPnl);
    cumulative = cumulative.plus(pnl);
    if (cumulative.gt(peak)) peak = cumulative;
    const drawdown = cumulative.minus(peak);

    // Converte para data BRT (UTC-3)
    const brtDate = new Date(t.exitAt.getTime() - 3 * 60 * 60 * 1000);
    const dateKey = brtDate.toISOString().slice(0, 10);

    points.push({
      timestamp: t.exitAt.toISOString(),
      date: dateKey,
      trade_pnl_brl: toFixed2(pnl),
      cumulative_pnl_brl: toFixed2(cumulative),
      drawdown_brl: toFixed2(drawdown),
    });

    const cur = dailyMap.get(dateKey) ?? {
      tradesCount: 0,
      wins: 0,
      losses: 0,
      pnl: toDecimal('0'),
    };
    cur.tradesCount += 1;
    if (pnl.gt(0)) cur.wins += 1;
    else if (pnl.lt(0)) cur.losses += 1;
    cur.pnl = cur.pnl.plus(pnl);
    dailyMap.set(dateKey, cur);
  }

  const dailyCalendar: DailyCalendarBucketDto[] = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      trades_count: agg.tradesCount,
      wins: agg.wins,
      losses: agg.losses,
      net_pnl_brl: toFixed2(agg.pnl),
    }));

  return { points, daily_calendar: dailyCalendar };
}

/**
 * Segmentador multidimensional e sintetizador de insights determinísticos (`SPEC-16`, `SPEC-17`).
 * Estritamente heurístico (sem LLM e sem recomendação de ativos — conformidade CVM `RNF-28`).
 *
 * @spec SPEC-16
 * @spec SPEC-17
 * @rf RF-M2-3
 * @rf RF-M2-4
 * @rnf RNF-28
 * @rnf RNF-29
 */
export function computeBreakdownAndInsights(
  trades: TradeAnalyticsRow[],
  dimension: 'hour_bucket' | 'day_of_week' | 'ticker' | 'setup_id',
): AnalyticsBreakdownResponse {
  const groups = new Map<
    string,
    { trades: number; wins: number; grossProfit: Decimal; grossLoss: Decimal; netPnl: Decimal }
  >();

  let totalNetLosses = toDecimal('0');

  for (const t of trades) {
    const brtDate = new Date(t.exitAt.getTime() - 3 * 60 * 60 * 1000);
    let key: string;
    if (dimension === 'hour_bucket') {
      key = `${String(brtDate.getUTCHours()).padStart(2, '0')}h`;
    } else if (dimension === 'day_of_week') {
      key = WEEKDAY_LABELS_PT[brtDate.getUTCDay()] ?? 'SEGUNDA';
    } else if (dimension === 'ticker') {
      key = t.ticker;
    } else {
      key = t.setupName?.trim() || 'Sem Setup';
    }

    const pnl = toDecimal(t.netPnl);
    if (pnl.lt(0)) {
      totalNetLosses = totalNetLosses.plus(pnl.abs());
    }

    const cur = groups.get(key) ?? {
      trades: 0,
      wins: 0,
      grossProfit: toDecimal('0'),
      grossLoss: toDecimal('0'),
      netPnl: toDecimal('0'),
    };
    cur.trades += 1;
    if (pnl.gt(0)) {
      cur.wins += 1;
      cur.grossProfit = cur.grossProfit.plus(pnl);
    } else if (pnl.lt(0)) {
      cur.grossLoss = cur.grossLoss.plus(pnl.abs());
    }
    cur.netPnl = cur.netPnl.plus(pnl);
    groups.set(key, cur);
  }

  const buckets: BreakdownBucketDto[] = [...groups.entries()]
    .map(([key, g]) => {
      const winRate =
        g.trades > 0
          ? toDecimal(String(g.wins)).div(String(g.trades)).toDecimalPlaces(4).toFixed(4)
          : '0.0000';
      const pf = g.grossLoss.gt(0) ? toFixed2(g.grossProfit.div(g.grossLoss)) : null;
      return {
        key,
        trades: g.trades,
        win_rate: winRate,
        net_pnl_brl: toFixed2(g.netPnl),
        profit_factor: pf,
      };
    })
    .sort((a, b) => toDecimal(b.net_pnl_brl).comparedTo(toDecimal(a.net_pnl_brl)));

  // Insights heurísticos com amostra mínima >= 5 operações (SPEC-17 Regra 2)
  const insights: DeterministicInsightDto[] = [];
  for (const bucket of buckets) {
    if (bucket.trades < 5) continue;
    const netDec = toDecimal(bucket.net_pnl_brl);

    if (netDec.lt(0) && totalNetLosses.gt(0)) {
      const sharePct = netDec.abs().div(totalNetLosses).mul('100');
      if (sharePct.gte('35')) {
        insights.push({
          code: `LOSS_CONCENTRATION_${dimension.toUpperCase()}`,
          severity: 'warning',
          message: `${bucket.key} concentra ${toFixed2(sharePct)}% das suas perdas no período (${formatBrl(netDec)} em ${bucket.trades} operações).`,
          sample_size: bucket.trades,
        });
      }
    } else if (netDec.gt(0) && toDecimal(bucket.win_rate).gte('0.60')) {
      const wrPct = toDecimal(bucket.win_rate).mul('100');
      insights.push({
        code: `HIGH_CONSISTENCY_${dimension.toUpperCase()}`,
        severity: 'positive',
        message: `${bucket.key} apresenta ${toFixed2(wrPct)}% de acerto com resultado líquido de ${formatBrl(netDec)} em ${bucket.trades} operações.`,
        sample_size: bucket.trades,
      });
    }
  }

  return { dimension, buckets, insights };
}

export class AnalyticsService {
  private async fetchScopedTrades(from?: string, to?: string): Promise<TradeAnalyticsRow[]> {
    return runInRlsTransaction(async (tx) => {
      const exitAtFilter: { gte?: Date; lte?: Date } = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) exitAtFilter.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) exitAtFilter.lte = d;
      }

      const rows = await tx.trade.findMany({
        where:
          exitAtFilter.gte || exitAtFilter.lte ? { exitAt: exitAtFilter } : undefined,
        orderBy: { exitAt: 'asc' },
        select: {
          id: true,
          ticker: true,
          setupName: true,
          followedPlan: true,
          exitAt: true,
          netPnl: true,
        },
      });

      return rows.map((r) => ({
        id: r.id,
        ticker: r.ticker,
        setupName: r.setupName,
        followedPlan: r.followedPlan,
        exitAt: r.exitAt,
        netPnl: toNumeric4String(r.netPnl.toString()),
      }));
    });
  }

  public async getSummary(from?: string, to?: string): Promise<AnalyticsSummaryResponse> {
    const trades = await this.fetchScopedTrades(from, to);
    return computeDeterministicSummary(trades);
  }

  public async getEquityCurve(from?: string, to?: string): Promise<EquityCurveResponse> {
    const trades = await this.fetchScopedTrades(from, to);
    return computeEquityCurveAndCalendar(trades);
  }

  public async getBreakdown(
    dimension: 'hour_bucket' | 'day_of_week' | 'ticker' | 'setup_id',
    from?: string,
    to?: string,
  ): Promise<AnalyticsBreakdownResponse> {
    const trades = await this.fetchScopedTrades(from, to);
    return computeBreakdownAndInsights(trades, dimension);
  }
}

export const analyticsService = new AnalyticsService();
