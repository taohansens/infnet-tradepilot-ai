import Link from 'next/link';

/**
 * Página inicial placeholder do TradePilot AI (Sprint 1 — Fundação).
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @spec SPEC-18
 * @rnf RNF-11
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-30
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-4">
        <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-profit">
          Sprint 1 · Fundação, Segurança &amp; RLS Ativo
        </span>
        <h1 className="text-4xl font-semibold tracking-tight text-white">
          TradePilot AI
        </h1>
        <p className="max-w-2xl text-base text-slate-300">
          Diário operacional, analytics determinístico com Raio-X da Fórmula e
          gestão fiscal B3 (Day Trade / Swing Trade) com isolamento multi-tenant
          por Row-Level Security e trilha de auditoria imutável.
        </p>

        <nav aria-label="Acessos da Sprint 1" className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/cadastro"
            className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
          >
            Criar Conta (/cadastro)
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-slate-700 bg-surface-900 px-4 py-2.5 text-sm font-medium text-slate-100 transition hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Entrar (/login)
          </Link>
          <Link
            href="/configuracoes/dados"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-200 transition hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          >
            Dados &amp; LGPD (/configuracoes/dados)
          </Link>
        </nav>
      </header>

      <section
        aria-label="Status da arquitetura base"
        className="grid gap-4 md:grid-cols-3"
      >
        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <h2 className="text-sm font-medium text-profit">
            Isolamento Multi-Tenant (RNF-11)
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            PostgreSQL com FORCE ROW LEVEL SECURITY e injeção automática de{' '}
            <code className="text-slate-200">app.current_user_id</code> por
            transação.
          </p>
        </article>

        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <h2 className="text-sm font-medium text-fiscal">
            Auditoria Append-Only (SPEC-04)
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Tabela <code className="text-slate-200">audit_logs</code> sem
            permissão de UPDATE/DELETE e protegida por trigger de imutabilidade.
          </p>
        </article>

        <article className="rounded-xl border border-slate-800 bg-surface-900 p-5">
          <h2 className="text-sm font-medium text-slate-100">
            Precisão Monetária Exata
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Valores financeiros e preços em{' '}
            <code className="text-slate-200">NUMERIC(18,4)</code> e{' '}
            <code className="text-slate-200">Decimal</code>, sem ponto flutuante
            binário.
          </p>
        </article>
      </section>
    </main>
  );
}
