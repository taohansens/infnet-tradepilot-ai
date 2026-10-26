'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  ApiClientError,
  loginAccount,
  saveAuthTokens,
} from '@/lib/apiClient';

/**
 * Tela de Login com suporte a autenticação JWT + 2FA TOTP opcional.
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
      router.push('/configuracoes/dados');
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
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-2xl border border-slate-800 bg-surface-900 p-8 shadow-xl">
        <header className="mb-6 space-y-2">
          <Link
            href="/"
            className="text-xs font-semibold uppercase tracking-wider text-profit hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            TradePilot AI
          </Link>
          <h1 className="text-2xl font-semibold text-white">Entrar na sua conta</h1>
          <p className="text-sm text-slate-300">
            Acesso protegido com JWT e isolamento individual de dados (RLS).
          </p>
        </header>

        {errorMessage && (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {errorMessage}
          </div>
        )}

        {infoMessage && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          >
            {infoMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-sm font-medium text-slate-200"
            >
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
              className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-400 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="mb-1.5 block text-sm font-medium text-slate-200"
            >
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
              className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-400 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
          </div>

          {requires2fa && (
            <div>
              <label
                htmlFor="login-totp"
                className="mb-1.5 block text-sm font-medium text-amber-300"
              >
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
                aria-describedby="totp-help"
                className="w-full rounded-lg border border-amber-500/60 bg-surface-950 px-3.5 py-2.5 text-sm tracking-widest text-white placeholder-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              />
              <p id="totp-help" className="mt-1 text-xs text-slate-400">
                Digite o código de 6 dígitos exibido no seu aplicativo autenticador.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Autenticando...' : requires2fa ? 'Validar código 2FA' : 'Entrar'}
          </button>
        </form>

        <footer className="mt-6 flex flex-col gap-2 border-t border-slate-800 pt-5 text-center text-sm text-slate-300">
          <p>
            Ainda não tem conta?{' '}
            <Link
              href="/cadastro"
              className="font-medium text-profit underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Criar conta gratuita
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
