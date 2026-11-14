'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { FiShield, FiSliders } from 'react-icons/fi';
import { formatBrl, toDecimal } from '@tradepilot/shared';
import AppShell from '@/components/AppShell';
import { useAppTheme } from '@/components/ThemeProvider';

/**
 * Gestão de Parâmetros e Tetos de Risco no visual do `RiskManagementPage` do Taometria (`SPEC-21`, `SPEC-22`).
 * Valida hierarquia estrita: `max_loss_trade <= max_loss_day <= max_loss_week <= max_loss_month`.
 *
 * @spec SPEC-21
 * @spec SPEC-22
 * @rf RF-M7-1
 * @rf RF-M7-2
 * @rnf RNF-20
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-28
 */

const STORAGE_KEY = 'tradepilot_risk_params';

interface RiskParameters {
  capitalBrl: string;
  maxLossTradeBrl: string;
  maxLossDayBrl: string;
  maxLossWeekBrl: string;
  maxLossMonthBrl: string;
}

const DEFAULT_PARAMS: RiskParameters = {
  capitalBrl: '20000.00',
  maxLossTradeBrl: '200.00',
  maxLossDayBrl: '600.00',
  maxLossWeekBrl: '1800.00',
  maxLossMonthBrl: '4000.00',
};

export default function RiscoParametrosPage() {
  const { openCalculator } = useAppTheme();
  const [params, setParams] = useState<RiskParameters>(DEFAULT_PARAMS);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setParams(JSON.parse(raw) as RiskParameters);
      } catch {
        // mantém padrão
      }
    }
  }, []);

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg(null);
    setSavedMsg(null);

    try {
      const cap = toDecimal(params.capitalBrl.replace(',', '.'));
      const trade = toDecimal(params.maxLossTradeBrl.replace(',', '.'));
      const day = toDecimal(params.maxLossDayBrl.replace(',', '.'));
      const week = toDecimal(params.maxLossWeekBrl.replace(',', '.'));
      const month = toDecimal(params.maxLossMonthBrl.replace(',', '.'));

      if (cap.lte(0) || trade.lte(0)) {
        setErrorMsg('Capital e limite por operação devem ser maiores que zero.');
        return;
      }

      if (!(trade.lte(day) && day.lte(week) && week.lte(month))) {
        setErrorMsg(
          'Inconsistência hierárquica: os tetos devem respeitar Operação ≤ Dia ≤ Semana ≤ Mês.',
        );
        return;
      }

      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
      setSavedMsg('Parâmetros e tetos de risco salvos com sucesso.');
    } catch {
      setErrorMsg('Informe valores monetários válidos.');
    }
  }

  return (
    <AppShell subtitle="Governança & Gestão de Risco">
      <div className="space-y-5">
        <section className="ui-panel">
          <div className="ui-hero-band flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted-2)]">
                <FiShield className="h-3.5 w-3.5 text-profit" />
                Proteção de Capital (SPEC-21 / SPEC-22)
              </p>
              <h1 className="mt-0.5 text-2xl font-black">
                Parâmetros e Tetos de Risco
              </h1>
            </div>

            <button
              type="button"
              onClick={openCalculator}
              className="ui-button-primary text-xs"
            >
              <FiSliders className="h-4 w-4" />
              Abrir Calculadora de Posição (Alt+C / Ctrl+K)
            </button>
          </div>

          <div className="grid gap-5 p-5 lg:grid-cols-3">
            <form onSubmit={handleSave} className="space-y-4 lg:col-span-2">
              {errorMsg && (
                <div
                  role="alert"
                  className="rounded-2xl border border-red-500/45 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                >
                  {errorMsg}
                </div>
              )}
              {savedMsg && (
                <div
                  role="status"
                  className="rounded-2xl border border-emerald-500/45 bg-emerald-500/10 px-4 py-3 text-sm text-profit"
                >
                  {savedMsg}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="risk-cap" className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                    Capital de Referência (R$)
                  </label>
                  <input
                    id="risk-cap"
                    value={params.capitalBrl}
                    onChange={(e) => setParams({ ...params, capitalBrl: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="risk-trade" className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                    Perda Máxima por Operação (R$)
                  </label>
                  <input
                    id="risk-trade"
                    value={params.maxLossTradeBrl}
                    onChange={(e) => setParams({ ...params, maxLossTradeBrl: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="risk-day" className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                    Perda Máxima Diária (R$)
                  </label>
                  <input
                    id="risk-day"
                    value={params.maxLossDayBrl}
                    onChange={(e) => setParams({ ...params, maxLossDayBrl: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="risk-week" className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                    Perda Máxima Semanal (R$)
                  </label>
                  <input
                    id="risk-week"
                    value={params.maxLossWeekBrl}
                    onChange={(e) => setParams({ ...params, maxLossWeekBrl: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="risk-month" className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                    Perda Máxima Mensal (R$)
                  </label>
                  <input
                    id="risk-month"
                    value={params.maxLossMonthBrl}
                    onChange={(e) => setParams({ ...params, maxLossMonthBrl: e.target.value })}
                    className="ui-input font-mono"
                  />
                </div>
              </div>

              <button type="submit" className="ui-button-primary">
                Salvar Limites de Risco
              </button>
            </form>

            <aside className="ui-panel-soft space-y-3 p-5">
              <h2 className="text-sm font-bold">Resumo da Hierarquia de Defesa</h2>
              <dl className="space-y-2.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-[var(--app-muted)]">Capital</dt>
                  <dd className="font-mono font-bold">{formatBrl(params.capitalBrl || '0')}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--app-muted)]">Stop por Trade</dt>
                  <dd className="font-mono font-bold text-loss">{formatBrl(params.maxLossTradeBrl || '0')}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--app-muted)]">Teto Diário</dt>
                  <dd className="font-mono font-bold text-loss">{formatBrl(params.maxLossDayBrl || '0')}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--app-muted)]">Teto Semanal</dt>
                  <dd className="font-mono font-bold text-fiscal">{formatBrl(params.maxLossWeekBrl || '0')}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--app-muted)]">Teto Mensal</dt>
                  <dd className="font-mono font-bold text-fiscal">{formatBrl(params.maxLossMonthBrl || '0')}</dd>
                </div>
              </dl>
              <p className="border-t border-[var(--app-line)] pt-3 text-[11px] text-[var(--app-muted)]">
                Pressione <strong>Alt+C</strong> ou <strong>Ctrl+K</strong> em qualquer tela para dimensionar sua posição sem sair do fluxo operacional.
              </p>
            </aside>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
