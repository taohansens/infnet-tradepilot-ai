'use client';

import { FiHelpCircle, FiX } from 'react-icons/fi';
import type { FormulaXRayDto } from '@tradepilot/shared';

/**
 * Componente Universal "Raio-X da Fórmula" (`SPEC-20`, `FN-PLT-07`, `ADR-02`, `RNF-29`).
 * Permite auditar a fórmula algébrica, os valores brutos do usuário e a substituição passo a passo.
 *
 * @spec SPEC-20
 * @rnf RNF-24
 * @rnf RNF-29
 */

export function FormulaXRayButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Ver Raio-X da fórmula de ${label}`}
      title={`Raio-X da fórmula: ${label}`}
      className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-line)] text-[var(--app-muted)] transition hover:border-emerald-400 hover:text-profit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
    >
      <FiHelpCircle className="h-3.5 w-3.5" />
    </button>
  );
}

export default function FormulaXRayModal({
  xray,
  onClose,
}: {
  xray: FormulaXRayDto | null;
  onClose: () => void;
}) {
  if (!xray) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="xray-modal-title"
    >
      <div className="w-full max-w-lg rounded-3xl border border-[var(--app-line)] bg-[var(--app-surface-strong)] p-6 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--app-line)] pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-profit">
              Raio-X da Fórmula · Transparência Matemática
            </p>
            <h3
              id="xray-modal-title"
              className="mt-1 text-lg font-bold text-[var(--app-text)]"
            >
              {xray.label}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar Raio-X"
            className="rounded-full border border-[var(--app-line)] p-2 text-[var(--app-muted)] hover:text-[var(--app-text)]"
          >
            <FiX className="h-4 w-4" />
          </button>
        </header>

        <div className="mt-4 space-y-4 text-sm">
          <div className="ui-panel-soft p-3.5">
            <p className="text-xs font-semibold uppercase text-[var(--app-muted)]">
              Expressão Algébrica
            </p>
            <p className="mt-1 font-mono text-sm font-semibold text-[var(--app-text)]">
              {xray.formula}
            </p>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-[var(--app-muted)]">
              Valores Brutos da Sua Conta no Período
            </p>
            <dl className="grid grid-cols-2 gap-2">
              {Object.entries(xray.inputs).map(([key, val]) => (
                <div key={key} className="ui-stat-tile py-2.5">
                  <dt className="text-[11px] uppercase text-[var(--app-muted)]">
                    {key.replace(/_/g, ' ')}
                  </dt>
                  <dd className="mt-0.5 font-mono text-sm font-bold text-[var(--app-text)]">
                    {val}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-3.5">
            <p className="text-xs font-semibold uppercase text-profit">
              Substituição Passo a Passo
            </p>
            <p className="mt-1 font-mono text-xs text-[var(--app-text)]">
              {xray.substitution}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
