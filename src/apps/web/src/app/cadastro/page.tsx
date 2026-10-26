'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { MIN_PASSWORD_LENGTH } from '@tradepilot/shared';
import {
  ApiClientError,
  registerAccount,
  saveAuthTokens,
} from '@/lib/apiClient';

/**
 * Tela de Cadastro com validação de senha forte (>= 10 caracteres) e aceite obrigatório LGPD.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 * @rnf RNF-13
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function CadastroPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lgpdConsent, setLgpdConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const passwordLongEnough = password.length >= MIN_PASSWORD_LENGTH;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    if (!passwordLongEnough) {
      setErrorMessage(
        `A senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
      return;
    }

    if (!lgpdConsent) {
      setErrorMessage(
        'Você precisa aceitar os termos de privacidade e consentimento LGPD para continuar.',
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await registerAccount({
        name,
        email,
        password,
        lgpd_consent: lgpdConsent,
      });

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
          <h1 className="text-2xl font-semibold text-white">Criar conta</h1>
          <p className="text-sm text-slate-300">
            Seus dados operacionais e fiscais ficam isolados por conta (RLS) e sob seu controle total (LGPD).
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

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label
              htmlFor="register-name"
              className="mb-1.5 block text-sm font-medium text-slate-200"
            >
              Nome completo
            </label>
            <input
              id="register-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Rafael Silva"
              className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-400 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
          </div>

          <div>
            <label
              htmlFor="register-email"
              className="mb-1.5 block text-sm font-medium text-slate-200"
            >
              E-mail
            </label>
            <input
              id="register-email"
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
              htmlFor="register-password"
              className="mb-1.5 block text-sm font-medium text-slate-200"
            >
              Senha (mínimo {MIN_PASSWORD_LENGTH} caracteres)
            </label>
            <input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="password-hint"
              aria-invalid={password.length > 0 && !passwordLongEnough}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Crie uma senha forte"
              className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-400 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            />
            <p
              id="password-hint"
              className={`mt-1.5 text-xs ${
                password.length === 0
                  ? 'text-slate-400'
                  : passwordLongEnough
                    ? 'text-profit'
                    : 'text-amber-300'
              }`}
            >
              {passwordLongEnough
                ? 'Requisito mínimo de 10 caracteres atendido.'
                : `Faltam ${Math.max(0, MIN_PASSWORD_LENGTH - password.length)} caracteres (mínimo ${MIN_PASSWORD_LENGTH}).`}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-surface-950 p-3.5">
            <label
              htmlFor="register-lgpd"
              className="flex cursor-pointer items-start gap-3 text-sm text-slate-200"
            >
              <input
                id="register-lgpd"
                name="lgpd_consent"
                type="checkbox"
                required
                checked={lgpdConsent}
                onChange={(e) => setLgpdConsent(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-600 bg-surface-900 text-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
              <span>
                Declaro que li e concordo com o tratamento dos meus dados operacionais e fiscais conforme a{' '}
                <strong className="text-white">LGPD (Lei 13.709/2018)</strong>, ciente do direito de exportação integral e exclusão definitiva a qualquer momento.
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Criando conta...' : 'Criar conta e continuar'}
          </button>
        </form>

        <footer className="mt-6 border-t border-slate-800 pt-5 text-center text-sm text-slate-300">
          Já possui conta?{' '}
          <Link
            href="/login"
            className="font-medium text-profit underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Fazer login
          </Link>
        </footer>
      </div>
    </main>
  );
}
