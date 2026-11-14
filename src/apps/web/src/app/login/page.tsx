'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FiMoon, FiSun } from 'react-icons/fi';
import { useAppTheme } from '@/components/ThemeProvider';
import {
  ApiClientError,
  loginAccount,
  saveAuthTokens,
} from '@/lib/apiClient';

/**
 * Tela de Login no estilo split hero do Taometria (`.auth-shell`),
 * com suporte a JWT + 2FA TOTP opcional e alternância Tema Dracula / Claro.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function LoginPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useAppTheme();
  const isDark = theme === 'dracula';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requires2fa, setRequires2fa] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);
    setSubmitting(true);

    try {
      const result = await loginAccount({
        email,
        password,
        totp_code: requires2fa ? totpCode : undefined,
      });

      if ('requires_2fa' in result) {
        setRequires2fa(true);
        setInfoMessage(result.message);
        return;
      }

      saveAuthTokens(result);
      router.push(result.requires_onboarding ? '/onboarding' : '/dashboard');
    } catch (error) {
      if (error instanceof ApiClientError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage('Falha de conexão com a API. Verifique se o servidor está ativo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell min-h-screen px-6 py-10">
      <div className="mx-auto mb-8 flex w-full max-w-5xl items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#bd93f9] text-sm font-black text-[#282a36]">
            TP
          </span>
          <span className="text-sm font-extrabold tracking-tight">TradePilot AI</span>
        </Link>

        <button
          type="button"
          onClick={toggleTheme}
          className="ui-button-secondary rounded-full px-4 py-2 text-xs"
        >
          {isDark ? <FiSun className="h-4 w-4" /> : <FiMoon className="h-4 w-4" />}
          {isDark ? 'Tema Claro' : 'Tema Dracula'}
        </button>
      </div>

      <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
        <section className="desk-panel space-y-5 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-profit">
            Plataforma Operacional &amp; Fiscal B3
          </p>
          <h1 className="text-4xl font-black leading-tight tracking-tight">
            Controle seus trades com clareza, precisão e disciplina.
          </h1>
          <p className="max-w-xl text-sm text-[var(--app-muted)]">
            Importe extratos da B3 e ordens do Profit com deduplicação automática, acompanhe sua curva de capital com Raio-X da Fórmula e mantenha seus dados protegidos por isolamento individual e LGPD.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Importação', 'B3 + Profit + Conciliação'],
              ['Analytics', 'KPIs, Curva e Raio-X (?)'],
              ['Risco & LGPD', 'Ctrl+K, RLS e Auditoria'],
            ].map(([title, desc]) => (
              <div key={title} className="ui-panel-soft px-4 py-3">
                <p className="text-sm font-bold">{title}</p>
                <p className="mt-1 text-xs text-[var(--app-muted)]">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ui-panel p-8">
          <header className="mb-6 space-y-1">
            <h2 className="text-2xl font-bold">Entrar na sua conta</h2>
            <p className="text-sm text-[var(--app-muted)]">
              Sessão protegida com JWT e isolamento individual de dados.
            </p>
          </header>

          {errorMessage && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              {errorMessage}
            </div>
          )}

          {infoMessage && (
            <div
              role="status"
              aria-live="polite"
              className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            >
              {infoMessage}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="login-email" className="mb-1.5 block text-xs font-semibold text-[var(--app-muted)]">
                E-mail
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@exemplo.com.br"
                className="ui-input"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-xs font-semibold text-[var(--app-muted)]">
                Senha
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Sua senha de acesso"
                className="ui-input"
              />
            </div>

            {requires2fa && (
              <div>
                <label htmlFor="login-totp" className="mb-1.5 block text-xs font-semibold text-fiscal">
                  Código 2FA (TOTP — 6 dígitos)
                </label>
                <input
                  id="login-totp"
                  name="totp_code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="ui-input tracking-widest"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="ui-button-primary w-full disabled:opacity-60"
            >
              {submitting ? 'Autenticando...' : requires2fa ? 'Validar código 2FA' : 'Entrar'}
            </button>
          </form>

          <footer className="mt-6 border-t border-[var(--app-line)] pt-5 text-center text-sm text-[var(--app-muted)]">
            Ainda não tem conta?{' '}
            <Link href="/cadastro" className="font-semibold text-profit hover:underline">
              Criar conta gratuita
            </Link>
          </footer>
        </section>
      </div>
    </main>
  );
}
