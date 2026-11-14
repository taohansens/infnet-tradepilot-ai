import { describe, expect, it } from 'vitest';
import {
  computeBreakdownAndInsights,
  computeDeterministicSummary,
  computeEquityCurveAndCalendar,
  type TradeAnalyticsRow,
} from '../services/analyticsService.js';

/**
 * Golden Tests do Motor Determinístico de Métricas Core (`SPEC-14`, `SPEC-15`, `SPEC-16`, `SPEC-17`, `SPEC-20`).
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
 * @rnf RNF-19
 * @rnf RNF-20
 * @rnf RNF-29
 */
describe('AnalyticsService Golden Tests (SPEC-14 a SPEC-17, SPEC-20)', () => {
  it('[SPEC-14] Dado 10 trades (6 ganhos de R$ 200 e 4 perdas de R$ 100), Então retorna win_rate=0.60, payoff=2.00, profit_factor=3.00 e expectancy_brl=80.00', () => {
    const baseTime = new Date('2026-10-01T14:00:00Z').getTime();
    const trades: TradeAnalyticsRow[] = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `win-${i}`,
        ticker: 'WINZ26',
        setupName: 'Rompimento VWAP',
        followedPlan: true,
        exitAt: new Date(baseTime + i * 600_000),
        netPnl: '200.0000',
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `loss-${i}`,
        ticker: 'WINZ26',
        setupName: 'Pullback M9',
        followedPlan: false,
        exitAt: new Date(baseTime + (6 + i) * 600_000),
        netPnl: '-100.0000',
      })),
    ];

    const summary = computeDeterministicSummary(trades);

    expect(summary.total_trades).toBe(10);
    expect(summary.win_rate).toBe('0.6000');
    expect(summary.payoff).toBe('2.00');
    expect(summary.profit_factor).toBe('3.00');
    expect(summary.expectancy_brl).toBe('80.00');
    expect(summary.total_pnl_brl).toBe('800.00');
    expect(summary.max_win_streak).toBe(6);
    expect(summary.max_loss_streak).toBe(4);
    expect(summary.max_drawdown_brl).toBe('-400.00');
    expect(summary.xray.profit_factor?.formula).toContain('Lucro Bruto');
  });

  it('[SPEC-15][SPEC-16][SPEC-17] Gera curva de capital, calendário diário e insights determinísticos com amostra >= 5', () => {
    const fridayBase = new Date('2026-10-09T14:00:00Z').getTime(); // Sexta-feira
    const trades: TradeAnalyticsRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: `fri-${i}`,
      ticker: 'WDOX26',
      setupName: 'Abertura Gap',
      followedPlan: false,
      exitAt: new Date(fridayBase + i * 300_000),
      netPnl: '-150.0000',
    }));

    const curve = computeEquityCurveAndCalendar(trades);
    expect(curve.points).toHaveLength(6);
    expect(curve.points[5]?.cumulative_pnl_brl).toBe('-900.00');
    expect(curve.daily_calendar).toHaveLength(1);
    expect(curve.daily_calendar[0]?.net_pnl_brl).toBe('-900.00');

    const breakdown = computeBreakdownAndInsights(trades, 'day_of_week');
    expect(breakdown.buckets[0]?.key).toBe('SEXTA');
    expect(breakdown.insights.length).toBeGreaterThanOrEqual(1);
    expect(breakdown.insights[0]?.severity).toBe('warning');
  });
});
