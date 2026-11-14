import Link from 'next/link';
import AppShell from '@/components/AppShell';

/**
 * Página inicial do TradePilot AI usando o AppShell inspirado no Taometria.
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @spec SPEC-05
 * @spec SPEC-18
 * @rnf RNF-11
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-30
 */
export default function HomePage() {
  return (
    <AppShell subtitle="Visão Geral da Plataforma">
      <div className="space-y-5">
        <section className="desk-panel space-y-5 p-8">
          <span className="ui-chip text-profit">
            TradePilot AI · Visual Taometria + Motor Auditável B3
          </span>
          <h1 className="text-4xl font-black tracking-tight">
            Diário de Trade, Analytics Determinístico e Gestão de Risco
          </h1>
          <p className="max-w-2xl text-sm text-[var(--app-muted)]">
            Importe extratos da B3 e ordens do Profit com deduplicação SHA-256, resolva conflitos lado a lado, audite cada métrica com o Raio-X da Fórmula e dimensione posições com o atalho global Ctrl+K / Alt+C.
          </p>

          <nav aria-label="Atalhos principais" className="flex flex-wrap gap-3 pt-1">
            <Link href="/dashboard" className="ui-button-primary">
              Abrir Dashboard
            </Link>
            <Link href="/onboarding" className="ui-button-secondary">
              Onboarding (Base Demo)
            </Link>
            <Link href="/diario/importar" className="ui-button-secondary">
              Importar Extrato B3/Profit
            </Link>
            <Link href="/diario" className="ui-button-secondary">
              Diário &amp; Livro
            </Link>
            <Link href="/risco/parametros" className="ui-button-secondary">
              Gestão de Risco
            </Link>
            <Link href="/login" className="ui-button-secondary">
              Entrar / Cadastro
            </Link>
          </nav>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="ui-panel p-5">
            <h2 className="text-sm font-bold text-profit">
              Isolamento Multi-Tenant (RLS)
            </h2>
            <p className="mt-2 text-xs text-[var(--app-muted)]">
              PostgreSQL com FORCE ROW LEVEL SECURITY e injeção transacional de sessão por conta.
            </p>
          </article>

          <article className="ui-panel p-5">
            <h2 className="text-sm font-bold text-fiscal">
              Auditoria Imutável &amp; LGPD
            </h2>
            <p className="mt-2 text-xs text-[var(--app-muted)]">
              Histórico append-only sem permissão de UPDATE/DELETE, exportação ZIP (JSON + CSV) e exclusão com confirmação dupla.
            </p>
          </article>

          <article className="ui-panel p-5">
            <h2 className="text-sm font-bold">
              Precisão Decimal &amp; Raio-X (?)
            </h2>
            <p className="mt-2 text-xs text-[var(--app-muted)]">
              Zero float binário: cálculos determinísticos em Decimal e NUMERIC(18,4) auditáveis em 1 clique.
            </p>
          </article>
        </section>
      </div>
    </AppShell>
  );
}
