'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  FiActivity,
  FiBookOpen,
  FiCompass,
  FiDownloadCloud,
  FiGrid,
  FiLogOut,
  FiMoon,
  FiShield,
  FiSliders,
  FiSun,
} from 'react-icons/fi';
import { clearAuthTokens } from '@/lib/apiClient';
import { useAppTheme } from './ThemeProvider';

/**
 * Shell principal inspirado no `AppLayout` do Taometria:
 * Header sticky arredondado (`rounded-[28px]`), navegação em pílulas (`NavChip`),
 * alternância de tema Dracula / Claro e gatilho `Alt+C / Ctrl+K` para a Calculadora Passiva.
 *
 * @spec SPEC-18
 * @spec SPEC-22
 * @rnf RNF-23
 * @rnf RNF-24
 */

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: FiGrid },
  { href: '/diario/importar', label: 'Importar', icon: FiDownloadCloud },
  { href: '/diario', label: 'Diário & Livro', icon: FiBookOpen },
  { href: '/risco/parametros', label: 'Risco', icon: FiActivity },
  { href: '/onboarding', label: 'Onboarding', icon: FiCompass },
  { href: '/configuracoes/dados', label: 'Dados & LGPD', icon: FiShield },
];

export default function AppShell({
  children,
  subtitle = 'Painel Operacional',
}: {
  children: ReactNode;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme, openCalculator } = useAppTheme();
  const isDark = theme === 'dracula';

  function handleLogout() {
    clearAuthTokens();
    router.push('/login');
  }

  return (
    <div className="app-shell min-h-screen text-[var(--app-text)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1520px] flex-col gap-5 px-4 py-4 lg:px-6 lg:py-5">
        <header
          className={`sticky top-3 z-30 overflow-hidden rounded-[28px] border backdrop-blur-xl transition ${
            isDark
              ? 'border-white/10 bg-[linear-gradient(180deg,rgba(40,42,54,0.96),rgba(33,34,44,0.92))] shadow-[0_18px_50px_rgba(0,0,0,0.35)]'
              : 'border-white/80 bg-white/85 shadow-[0_18px_50px_rgba(15,23,42,0.08)]'
          }`}
        >
          <div className="flex flex-col gap-3 px-4 py-4 lg:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link
                href="/dashboard"
                className="flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <div
                  className={`flex h-11 w-11 items-center justify-center rounded-2xl text-lg font-black shadow-lg ${
                    isDark
                      ? 'bg-[#bd93f9] text-[#282a36]'
                      : 'bg-slate-900 text-white'
                  }`}
                >
                  TP
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--app-muted-2)]">
                      TradePilot AI
                    </p>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        isDark
                          ? 'border-[#50fa7b]/25 bg-[#50fa7b]/10 text-[#50fa7b]'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      Operacional B3
                    </span>
                  </div>
                  <p className="text-lg font-black tracking-tight text-[var(--app-text)]">
                    {subtitle}
                  </p>
                </div>
              </Link>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={openCalculator}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    isDark
                      ? 'border-white/10 bg-white/5 text-[#f8f8f2] hover:border-[#50fa7b]/40 hover:bg-white/10'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <FiSliders className="h-4 w-4 text-profit" />
                  <span>Calculadora</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      isDark
                        ? 'bg-white/10 text-[#f8f8f2]'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    Ctrl K
                  </span>
                </button>

                <button
                  type="button"
                  onClick={toggleTheme}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    isDark
                      ? 'border-white/10 bg-white/5 text-[#f8f8f2] hover:border-[#bd93f9]/40 hover:bg-white/10'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {isDark ? (
                    <FiSun className="h-4 w-4" />
                  ) : (
                    <FiMoon className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline">
                    {isDark ? 'Tema Claro' : 'Tema Dracula'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleLogout}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 ${
                    isDark
                      ? 'border-white/10 bg-white/5 text-[#f8f8f2] hover:border-[#ff5555]/40 hover:bg-[#ff5555]/15'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700'
                  }`}
                >
                  <FiLogOut className="h-4 w-4" />
                  <span>Sair</span>
                </button>
              </div>
            </div>

            <nav
              aria-label="Navegação principal"
              className="flex gap-2 overflow-x-auto pb-1 pt-1"
            >
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/diario' && pathname?.startsWith(`${item.href}/`));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                      isActive
                        ? isDark
                          ? 'border-[#bd93f9]/45 bg-[#44475a] text-[#f8f8f2] shadow-lg shadow-black/20'
                          : 'border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-900/15'
                        : isDark
                          ? 'border-white/10 bg-white/5 text-[#bdc3e6] hover:border-[#bd93f9]/30 hover:bg-white/10 hover:text-[#f8f8f2]'
                          : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:bg-white hover:text-slate-900'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-line)] pt-2.5 text-xs text-[var(--app-muted)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-chip">
                  <FiActivity className="h-3.5 w-3.5 text-profit" />
                  Isolamento Individual (RLS)
                </span>
                <span className="ui-chip">Mercado B3 · BRT</span>
              </div>
              <span className="ui-chip">Disciplina &amp; Precisão Decimal</span>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 pb-8">{children}</main>
      </div>
    </div>
  );
}
