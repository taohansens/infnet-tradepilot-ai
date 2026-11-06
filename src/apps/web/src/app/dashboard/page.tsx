'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { OnboardingStatusResponse } from '@tradepilot/shared';
import {
  clearOnboardingDemo,
  fetchOnboardingStatus,
  getAccessToken,
} from '@/lib/apiClient';

/**
 * Dashboard Executivo inicial com banner 1-clique para limpeza da Base Demonstrativa
 * (`is_demo = true`) ao importar dados reais (`SPEC-05`, `SPEC-18`).
 *
 * @spec SPEC-05
 * @spec SPEC-18
 * @rf RF-T-3
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function DashboardPage() {
  const [hasSession, setHasSession] = useState(true);
  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [clearingDemo, setClearingDemo] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchOnboardingStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!getAccessToken()) {
      setHasSession(false);
      return;
    }
    void loadStatus();
  }, [loadStatus]);

  async function handleClearDemo() {
    setClearingDemo(true);
    setFeedback(null);
    try {
      const res = await clearOnboardingDemo();
      setFeedback(res.message);
      await loadStatus();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : 'Não foi possível remover a base demonstrativa.',
      );
    } finally {
      setClearingDemo(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-6 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-profit">
            TradePilot AI · Dashboard Executivo
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-white">
            Primeiro Diagnóstico Operacional
          </h1>
        </div>

        <nav aria-label="Atalhos do Dashboard" className="flex flex-wrap gap-3">
          <Link
            href="/diario/importar"
            className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
          >
            Importar Extrato Real
          </Link>
          <Link
            href="/onboarding"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs text-slate-200 hover:bg-surface-800"
          >
            Onboarding
          </Link>
          <Link
            href="/configuracoes/dados"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs text-slate-200 hover:bg-surface-800"
          >
            Auditoria &amp; LGPD
          </Link>
        </nav>
      </header>

      {!hasSession && (
        <section
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100"
        >
          Faça login em{' '}
          <Link href="/login" className="font-semibold underline">
            /login
          </Link>{' '}
          para visualizar seus dados operacionais.
        </section>
      )}

      {/* Banner 1-clique para limpar Base Demonstrativa (SPEC-05 Regra 3) */}
      {status?.has_demo_trades && (
        <section
          role="region"
          aria-label="Aviso de Base Demonstrativa ativa"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-100"
        >
          <div>
            <p className="font-semibold text-fiscal">
              Modo Base Demonstrativa Ativo ({status.demo_trades_count} trades sintéticos)
            </p>
            <p className="mt-0.5 text-xs text-amber-200">
              Estes registros são apenas para demonstração. Limpe-os em 1 clique quando estiver pronto para usar apenas seus extratos reais.
            </p>
          </div>
          <button
            type="button"
            disabled={clearingDemo}
            onClick={handleClearDemo}
            className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50"
          >
            {clearingDemo
              ? 'Limpando base demo...'
              : 'Limpar Base Demonstrativa (1 clique)'}
          </button>
        </section>
      )}

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100"
        >
          {feedback}
        </div>
      )}

      <section
        aria-label="Resumo de operações"
        className="grid gap-4 sm:grid-cols-3"
      >
        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <p className="text-xs text-slate-400">Operações Reais</p>
          <p className="mt-1 text-3xl font-semibold text-profit">
            {status?.real_trades_count ?? 0}
          </p>
        </article>
        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <p className="text-xs text-slate-400">Operações Demo (is_demo)</p>
          <p className="mt-1 text-3xl font-semibold text-fiscal">
            {status?.demo_trades_count ?? 0}
          </p>
        </article>
        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <p className="text-xs text-slate-400">Status do Onboarding</p>
          <p className="mt-1 text-lg font-semibold text-white">
            {status?.onboarding_completed ? 'Concluído' : 'Pendente'}
          </p>
        </article>
      </section>
    </main>
  );
}
