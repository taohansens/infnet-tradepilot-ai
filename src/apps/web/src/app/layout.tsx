import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'TradePilot AI — Diário, Analytics e Fiscal B3',
  description:
    'Plataforma de diário operacional, analytics determinístico com Raio-X da Fórmula, gestão de risco passiva e apuração fiscal B3.',
};

/**
 * Layout raiz em PT-BR com tema Dracula padrão (Taometria) e acessibilidade WCAG 2.1 AA.
 *
 * @spec SPEC-18
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" data-theme="dracula" className="dark">
      <body className="min-h-screen">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
