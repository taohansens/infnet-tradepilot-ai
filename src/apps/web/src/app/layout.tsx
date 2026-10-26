import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'TradePilot AI — Diário, Analytics e Fiscal B3',
  description:
    'Plataforma de diário operacional, analytics determinístico, gestão de risco passiva e apuração fiscal B3.',
};

/**
 * Layout raiz em PT-BR com modo escuro padrão e acessibilidade WCAG 2.1 AA.
 *
 * @spec SPEC-18
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen bg-surface-950 text-slate-100">
        {children}
      </body>
    </html>
  );
}
