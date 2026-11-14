'use client';

import { useMemo, useState } from 'react';
import { FiSliders, FiX } from 'react-icons/fi';
import { formatBrl, toDecimal } from '@tradepilot/shared';

/**
 * Calculadora Passiva de Tamanho de Posição acessível via atalho global (`Alt+C` / `Ctrl+K`)
 * em qualquer tela como drawer lateral flutuante (`SPEC-22`).
 *
 * Estritamente passiva e determinística (conforme CVM `RNF-28`): calcula lote a partir
 * dos parâmetros informados pelo usuário, sem botão de ordem e sem recomendação de ativos.
 *
 * @spec SPEC-22
 * @rf RF-M7-2
 * @rnf RNF-20
 * @rnf RNF-24
 * @rnf RNF-28
 */

type CalcAssetType = 'WIN' | 'WDO' | 'ACOES';

export default function PositionCalculatorDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [assetType, setAssetType] = useState<CalcAssetType>('WIN');
  const [entryPrice, setEntryPrice] = useState('131000');
  const [stopPrice, setStopPrice] = useState('130800');
  const [targetPrice, setTargetPrice] = useState('131400');
  const [riskBrl, setRiskBrl] = useState('200.00');
  const [remainingDailyCapBrl, setRemainingDailyCapBrl] = useState('600.00');

  const result = useMemo(() => {
    try {
      const entry = toDecimal(entryPrice.replace(',', '.'));
      const stop = toDecimal(stopPrice.replace(',', '.'));
      const risk = toDecimal(riskBrl.replace(',', '.'));
      const dailyCap = toDecimal(remainingDailyCapBrl.replace(',', '.'));
      const dist = entry.minus(stop).abs();

      if (dist.lte(0) || risk.lte(0)) {
        return { valid: false as const, reason: 'Informe entrada, stop distintos e risco maior que zero.' };
      }

      const multiplier =
        assetType === 'WIN'
          ? toDecimal('0.20')
          : assetType === 'WDO'
            ? toDecimal('10.00')
            : toDecimal('1.00');

      const riskPerUnit = dist.mul(multiplier);
      const quantity = risk.div(riskPerUnit).floor();
      const actualRisk = quantity.mul(riskPerUnit);

      let rrRatio: string | null = null;
      if (targetPrice.trim()) {
        const target = toDecimal(targetPrice.replace(',', '.'));
        const rewardDist = target.minus(entry).abs();
        if (rewardDist.gt(0)) {
          rrRatio = rewardDist.div(dist).toDecimalPlaces(2).toFixed(2);
        }
      }

      return {
        valid: true as const,
        quantity: quantity.toFixed(0),
        unitLabel: assetType === 'ACOES' ? 'ações' : 'contratos',
        riskPerUnitBrl: formatBrl(riskPerUnit),
        actualRiskBrl: formatBrl(actualRisk),
        exceedsDailyCap: risk.gt(dailyCap),
        rrRatio,
        points: dist.toDecimalPlaces(2).toFixed(2),
      };
    } catch {
      return { valid: false as const, reason: 'Preencha valores numéricos válidos.' };
    }
  }, [assetType, entryPrice, stopPrice, targetPrice, riskBrl, remainingDailyCapBrl]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="calc-drawer-title"
    >
      <div className="flex h-full w-full max-w-md flex-col justify-between overflow-y-auto border-l border-[var(--app-line)] bg-[var(--app-surface-strong)] p-6 shadow-2xl">
        <div className="space-y-5">
          <header className="flex items-start justify-between gap-3 border-b border-[var(--app-line)] pb-4">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-profit">
                <FiSliders className="h-3.5 w-3.5" />
                Gestão de Risco Passiva · Alt+C / Ctrl+K
              </p>
              <h2
                id="calc-drawer-title"
                className="mt-1 text-xl font-bold text-[var(--app-text)]"
              >
                Calculadora de Posição
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar calculadora"
              className="rounded-full border border-[var(--app-line)] p-2 text-[var(--app-muted)] hover:text-[var(--app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <FiX className="h-4 w-4" />
            </button>
          </header>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'WIN', label: 'WIN (R$ 0,20/pt)' },
                { id: 'WDO', label: 'WDO (R$ 10/pt)' },
                { id: 'ACOES', label: 'Ações (B3)' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAssetType(opt.id)}
                className={`rounded-2xl border px-3 py-2 text-xs font-semibold transition ${
                  assetType === opt.id
                    ? 'border-emerald-500 bg-emerald-500/15 text-profit'
                    : 'border-[var(--app-line)] bg-[var(--app-surface-soft)] text-[var(--app-muted)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="calc-entry" className="mb-1 block text-xs font-medium text-[var(--app-muted)]">
                Preço de Entrada
              </label>
              <input
                id="calc-entry"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                className="ui-input font-mono"
              />
            </div>
            <div>
              <label htmlFor="calc-stop" className="mb-1 block text-xs font-medium text-[var(--app-muted)]">
                Preço de Stop
              </label>
              <input
                id="calc-stop"
                value={stopPrice}
                onChange={(e) => setStopPrice(e.target.value)}
                className="ui-input font-mono"
              />
            </div>
            <div>
              <label htmlFor="calc-target" className="mb-1 block text-xs font-medium text-[var(--app-muted)]">
                Alvo (opcional)
              </label>
              <input
                id="calc-target"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                className="ui-input font-mono"
              />
            </div>
            <div>
              <label htmlFor="calc-risk" className="mb-1 block text-xs font-medium text-[var(--app-muted)]">
                Risco Máximo (R$)
              </label>
              <input
                id="calc-risk"
                value={riskBrl}
                onChange={(e) => setRiskBrl(e.target.value)}
                className="ui-input font-mono"
              />
            </div>
          </div>

          <div>
            <label htmlFor="calc-daily-cap" className="mb-1 block text-xs font-medium text-[var(--app-muted)]">
              Teto Diário Restante (R$)
            </label>
            <input
              id="calc-daily-cap"
              value={remainingDailyCapBrl}
              onChange={(e) => setRemainingDailyCapBrl(e.target.value)}
              className="ui-input font-mono"
            />
          </div>

          {result.valid ? (
            <section className="ui-panel-soft space-y-3 p-4">
              {result.exceedsDailyCap && (
                <div
                  role="alert"
                  className="rounded-xl border border-red-500/50 bg-red-500/15 px-3 py-2 text-xs font-medium text-red-200"
                >
                  Atenção: o risco informado excede o seu teto diário restante.
                </div>
              )}

              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">
                  Tamanho Máximo Calculado
                </span>
                <span className="text-3xl font-black text-profit">
                  {result.quantity}{' '}
                  <span className="text-sm font-semibold">{result.unitLabel}</span>
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 border-t border-[var(--app-line)] pt-3 text-xs">
                <div>
                  <dt className="text-[var(--app-muted)]">Distância do Stop</dt>
                  <dd className="font-mono font-semibold text-[var(--app-text)]">
                    {result.points} pts
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--app-muted)]">Risco por Unidade</dt>
                  <dd className="font-mono font-semibold text-[var(--app-text)]">
                    {result.riskPerUnitBrl}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--app-muted)]">Risco Efetivo</dt>
                  <dd className="font-mono font-semibold text-loss">
                    {result.actualRiskBrl}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--app-muted)]">Risco / Retorno</dt>
                  <dd className="font-mono font-semibold text-[var(--app-text)]">
                    {result.rrRatio ? `1 : ${result.rrRatio}` : '—'}
                  </dd>
                </div>
              </dl>
            </section>
          ) : (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {result.reason}
            </p>
          )}
        </div>

        <footer className="mt-6 border-t border-[var(--app-line)] pt-3 text-[11px] text-[var(--app-muted)]">
          Ferramenta estritamente matemática e passiva. O TradePilot AI não executa ordens nem recomenda ativos ou direções operacionais.
        </footer>
      </div>
    </div>
  );
}
