'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FiAlertTriangle,
  FiCalendar,
  FiRefreshCw,
  FiTrendingUp,
} from 'react-icons/fi';
import {
  formatBrl,
  type AnalyticsBreakdownResponse,
  type AnalyticsSummaryResponse,
  type EquityCurveResponse,
  type FormulaXRayDto,
  type OnboardingStatusResponse,
} from '@tradepilot/shared';
import AppShell from '@/components/AppShell';
import EquityCurveChart from '@/components/EquityCurveChart';
import FormulaXRayModal, {
  FormulaXRayButton,
} from '@/components/FormulaXRayModal';
import {
  clearOnboardingDemo,
  fetchAnalyticsBreakdown,
  fetchAnalyticsSummary,
  fetchEquityCurve,
  fetchOnboardingStatus,
  getAccessToken,
} from '@/lib/apiClient';

/**
 * Dashboard Executivo no estilo visual do Taometria (`SPEC-14` a `SPEC-20`, `SPEC-05`):
 * - Filtro temporal global (`Geral / Hoje / 7D / Mês Atual / Personalizado`)
 * - Banner 1-clique para limpeza da base demonstrativa
 * - Cartões de KPI com botão universal `(?)` Raio-X da Fórmula (`SPEC-20`)
 * - Curva de Capital interativa (`lightweight-charts`, `SPEC-15`)
 * - Calendário Operacional colorido por P&L (`SPEC-18`)
 * - Segmentação por Setup/Horário/Dia/Ativo + Insights Determinísticos (`SPEC-16`, `SPEC-17`)
 *
 * @spec SPEC-05
 * @spec SPEC-14
 * @spec SPEC-15
 * @spec SPEC-16
 * @spec SPEC-17
 * @spec SPEC-18
 * @spec SPEC-19
 * @spec SPEC-20
 * @rf RF-M2-1
 * @rf RF-M2-2
 * @rf RF-M2-3
 * @rf RF-M2-4
 * @rf RF-M8-1
 * @rf RF-M8-2
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-29
 */

type PeriodPreset = 'all' | 'today' | '7d' | 'month' | 'custom';
type BreakdownDimension = 'setup_id' | 'hour_bucket' | 'day_of_week' | 'ticker';

const PERIOD_OPTIONS: Array<{ key: PeriodPreset; label: string }> = [
  { key: 'all', label: 'Geral' },
  { key: 'today', label: 'Hoje' },
  { key: '7d', label: '7D' },
  { key: 'month', label: 'Mês Atual' },
  { key: 'custom', label: 'Personalizado' },
];

const DIMENSION_OPTIONS: Array<{ key: BreakdownDimension; label: string }> = [
  { key: 'setup_id', label: 'Setup' },
  { key: 'hour_bucket', label: 'Horário' },
  { key: 'day_of_week', label: 'Dias' },
  { key: 'ticker', label: 'Ativo' },
];

export default function DashboardPage() {
  const [hasSession, setHasSession] = useState(true);
  const [preset, setPreset] = useState<PeriodPreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [dimension, setDimension] = useState<BreakdownDimension>('setup_id');

  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null);
  const [curve, setCurve] = useState<EquityCurveResponse | null>(null);
  const [breakdown, setBreakdown] = useState<AnalyticsBreakdownResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [clearingDemo, setClearingDemo] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [activeXRay, setActiveXRay] = useState<FormulaXRayDto | null>(null);

  const dateRange = useMemo(() => {
    const now = new Date();
    const endIso = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
    ).toISOString();

    if (preset === 'today') {
      const startIso = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
      ).toISOString();
      return { from: startIso, to: endIso };
    }
    if (preset === '7d') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { from: d.toISOString(), to: endIso };
    }
    if (preset === 'month') {
      const startIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      return { from: startIso, to: endIso };
    }
    if (preset === 'custom') {
      return {
        from: customFrom ? `${customFrom}T00:00:00-03:00` : undefined,
        to: customTo ? `${customTo}T23:59:59-03:00` : undefined,
      };
    }
    return { from: undefined, to: undefined };
  }, [preset, customFrom, customTo]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [st, sum, eq, br] = await Promise.all([
        fetchOnboardingStatus(),
        fetchAnalyticsSummary(dateRange.from, dateRange.to),
        fetchEquityCurve(dateRange.from, dateRange.to),
        fetchAnalyticsBreakdown(dimension, dateRange.from, dateRange.to),
      ]);
      setStatus(st);
      setSummary(sum);
      setCurve(eq);
      setBreakdown(br);
    } catch {
      // mantém estado anterior caso sessão tenha expirado
    } finally {
      setLoading(false);
    }
  }, [dateRange.from, dateRange.to, dimension]);

  useEffect(() => {
    if (!getAccessToken()) {
      setHasSession(false);
      return;
    }
    void loadAll();
  }, [loadAll]);

  async function handleClearDemo() {
    setClearingDemo(true);
    setFeedback(null);
    try {
      const res = await clearOnboardingDemo();
      setFeedback(res.message);
      await loadAll();
    } finally {
      setClearingDemo(false);
    }
  }

  const totalPnlPositive = Number(summary?.total_pnl_brl ?? 0) >= 0;
  const winRatePct = summary
    ? `${(Number(summary.win_rate) * 100).toFixed(1)}%`
    : '0,0%';

  return (
    <AppShell subtitle="Visão Consolidada · Analytics">
      <div className="space-y-5">
        {!hasSession && (
          <section
            role="alert"
            className="desk-panel flex flex-wrap items-center justify-between gap-4 border-amber-500/40 p-5 text-sm"
          >
            <div>
              <p className="font-bold text-fiscal">Sessão não autenticada</p>
              <p className="text-[var(--app-muted)]">
                Faça login ou crie sua conta para visualizar seus KPIs, curva de capital e calendário operacional.
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/login" className="ui-button-primary">
                Entrar
              </Link>
              <Link href="/cadastro" className="ui-button-secondary">
                Criar conta
              </Link>
            </div>
          </section>
        )}

        {/* Banner 1-clique para limpeza da base demonstrativa (SPEC-05) */}
        {status?.has_demo_trades && (
          <section className="ui-panel flex flex-wrap items-center justify-between gap-4 border-amber-500/45 bg-amber-500/10 p-4 text-sm">
            <div>
              <p className="font-bold text-fiscal">
                Modo Demonstração Ativo ({status.demo_trades_count} operações sintéticas)
              </p>
              <p className="text-xs text-[var(--app-muted)]">
                Estes registros são apenas para demonstração. Limpe-os em 1 clique quando importar seus extratos reais.
              </p>
            </div>
            <button
              type="button"
              disabled={clearingDemo}
              onClick={handleClearDemo}
              className="rounded-2xl bg-amber-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
            >
              {clearingDemo ? 'Limpando...' : 'Limpar Base Demonstrativa'}
            </button>
          </section>
        )}

        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-profit"
          >
            {feedback}
          </div>
        )}

        {/* Hero Band + Filtro Temporal Global (estilo Taometria, SPEC-19) */}
        <section className="ui-panel">
          <div className="ui-hero-band flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted-2)]">
                Filtro Temporal Global
              </p>
              <h1 className="mt-0.5 text-2xl font-black tracking-tight">
                Dashboard Executivo
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setPreset(opt.key)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                    preset === opt.key
                      ? 'border-emerald-500 bg-emerald-500/15 text-profit'
                      : 'border-[var(--app-line)] bg-[var(--app-surface-soft)] text-[var(--app-muted)] hover:text-[var(--app-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void loadAll()}
                disabled={loading}
                aria-label="Atualizar métricas"
                className="ui-button-secondary rounded-full px-3 py-1.5 text-xs"
              >
                <FiRefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Atualizar
              </button>
            </div>
          </div>

          {preset === 'custom' && (
            <div className="flex flex-wrap items-end gap-3 border-b border-[var(--app-line)] px-5 py-3">
              <div>
                <label htmlFor="dash-from" className="mb-1 block text-xs text-[var(--app-muted)]">
                  Início
                </label>
                <input
                  id="dash-from"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="ui-input py-1.5 text-xs"
                />
              </div>
              <div>
                <label htmlFor="dash-to" className="mb-1 block text-xs text-[var(--app-muted)]">
                  Fim
                </label>
                <input
                  id="dash-to"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="ui-input py-1.5 text-xs"
                />
              </div>
            </div>
          )}

          {/* KpiGrid com Raio-X da Fórmula (?) — SPEC-14 & SPEC-20 */}
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-6">
            <article className="ui-stat-tile lg:col-span-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  Resultado Líquido
                </p>
                <span className="ui-chip">{summary?.total_trades ?? 0} trades</span>
              </div>
              <p
                className={`mt-2 text-3xl font-black tracking-tight ${
                  totalPnlPositive ? 'text-profit' : 'text-loss'
                }`}
              >
                {formatBrl(summary?.total_pnl_brl ?? '0.00')}
              </p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">
                Ganhos: {summary?.winning_trades ?? 0} · Perdas: {summary?.losing_trades ?? 0}
              </p>
            </article>

            <article className="ui-stat-tile">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  Acerto
                </p>
                {summary?.xray.win_rate && (
                  <FormulaXRayButton
                    label="Taxa de Acerto"
                    onClick={() => setActiveXRay(summary.xray.win_rate ?? null)}
                  />
                )}
              </div>
              <p className="mt-2 text-2xl font-black">{winRatePct}</p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">
                Seq. máx: +{summary?.max_win_streak ?? 0} / -{summary?.max_loss_streak ?? 0}
              </p>
            </article>

            <article className="ui-stat-tile">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  Fator de Lucro
                </p>
                {summary?.xray.profit_factor && (
                  <FormulaXRayButton
                    label="Fator de Lucro"
                    onClick={() => setActiveXRay(summary.xray.profit_factor ?? null)}
                  />
                )}
              </div>
              <p className="mt-2 text-2xl font-black">
                {summary?.profit_factor ?? (summary?.profit_factor_infinite ? '∞' : '—')}
              </p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">
                Payoff: {summary?.payoff ?? '—'}
              </p>
            </article>

            <article className="ui-stat-tile">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  Expectativa
                </p>
                {summary?.xray.expectancy_brl && (
                  <FormulaXRayButton
                    label="Expectativa Matemática"
                    onClick={() => setActiveXRay(summary.xray.expectancy_brl ?? null)}
                  />
                )}
              </div>
              <p
                className={`mt-2 text-2xl font-black ${
                  Number(summary?.expectancy_brl ?? 0) >= 0 ? 'text-profit' : 'text-loss'
                }`}
              >
                {formatBrl(summary?.expectancy_brl ?? '0.00')}
              </p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">por operação</p>
            </article>

            <article className="ui-stat-tile">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  Drawdown Máx.
                </p>
                {summary?.xray.max_drawdown_brl && (
                  <FormulaXRayButton
                    label="Drawdown Máximo"
                    onClick={() => setActiveXRay(summary.xray.max_drawdown_brl ?? null)}
                  />
                )}
              </div>
              <p className="mt-2 text-2xl font-black text-loss">
                {formatBrl(summary?.max_drawdown_brl ?? '0.00')}
              </p>
              <p className="mt-1 text-xs text-[var(--app-muted)]">
                Plano seguido: {summary?.plan_adherence_pct ?? '0.00'}%
              </p>
            </article>
          </div>
        </section>

        {/* Curva de Capital + Calendário Operacional */}
        <div className="grid gap-5 lg:grid-cols-3">
          <section className="ui-panel p-5 lg:col-span-2">
            <header className="mb-4 flex items-center justify-between">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  <FiTrendingUp className="h-3.5 w-3.5 text-profit" />
                  Curva de Capital Acumulada
                </p>
                <h2 className="text-lg font-bold">Evolução do Resultado Líquido</h2>
              </div>
              <span className="ui-chip">
                {curve?.points.length ?? 0} ponto(s)
              </span>
            </header>
            <EquityCurveChart points={curve?.points ?? []} />
          </section>

          <section className="ui-panel p-5">
            <header className="mb-4 flex items-center justify-between">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                  <FiCalendar className="h-3.5 w-3.5 text-fiscal" />
                  Calendário Operacional
                </p>
                <h2 className="text-lg font-bold">Resultados por Pregão</h2>
              </div>
            </header>

            {!curve || curve.daily_calendar.length === 0 ? (
              <p className="text-sm text-[var(--app-muted)]">
                Nenhum pregão registrado no período selecionado.
              </p>
            ) : (
              <div className="grid max-h-[290px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                {curve.daily_calendar
                  .slice()
                  .reverse()
                  .map((day) => {
                    const positive = Number(day.net_pnl_brl) >= 0;
                    return (
                      <div
                        key={day.date}
                        className={`rounded-2xl border p-3 ${
                          positive
                            ? 'border-emerald-500/35 bg-emerald-500/10'
                            : 'border-red-500/35 bg-red-500/10'
                        }`}
                      >
                        <p className="font-mono text-[11px] text-[var(--app-muted)]">
                          {day.date}
                        </p>
                        <p
                          className={`mt-1 text-sm font-bold ${
                            positive ? 'text-profit' : 'text-loss'
                          }`}
                        >
                          {formatBrl(day.net_pnl_brl)}
                        </p>
                        <p className="text-[11px] text-[var(--app-muted)]">
                          {day.trades_count} op. ({day.wins}G / {day.losses}P)
                        </p>
                      </div>
                    );
                  })}
              </div>
            )}
          </section>
        </div>

        {/* Segmentador Multidimensional + Insights Determinísticos (SPEC-16, SPEC-17) */}
        <section className="ui-panel p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                Segmentador Multidimensional &amp; Insights Determinísticos
              </p>
              <h2 className="text-lg font-bold">Onde Você Ganha e Onde Perde</h2>
            </div>

            <div className="flex flex-wrap gap-2">
              {DIMENSION_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDimension(opt.key)}
                  className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                    dimension === opt.key
                      ? 'border-emerald-500 bg-emerald-500/15 text-profit'
                      : 'border-[var(--app-line)] bg-[var(--app-surface-soft)] text-[var(--app-muted)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {breakdown && breakdown.insights.length > 0 && (
            <div className="mb-4 grid gap-2 md:grid-cols-2">
              {breakdown.insights.map((ins) => (
                <div
                  key={`${ins.code}-${ins.message}`}
                  className={`flex items-start gap-2.5 rounded-2xl border p-3.5 text-xs ${
                    ins.severity === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                  }`}
                >
                  <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{ins.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(breakdown?.buckets ?? []).map((b) => {
              const positive = Number(b.net_pnl_brl) >= 0;
              return (
                <article key={b.key} className="ui-stat-tile">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-[var(--app-text)]">{b.key}</h3>
                    <span className="text-xs text-[var(--app-muted)]">
                      {b.trades} op.
                    </span>
                  </div>
                  <p
                    className={`mt-2 text-lg font-black ${
                      positive ? 'text-profit' : 'text-loss'
                    }`}
                  >
                    {formatBrl(b.net_pnl_brl)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--app-muted)]">
                    Acerto: {(Number(b.win_rate) * 100).toFixed(1)}% · PF:{' '}
                    {b.profit_factor ?? '—'}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <FormulaXRayModal
        xray={activeXRay}
        onClose={() => setActiveXRay(null)}
      />
    </AppShell>
  );
}
