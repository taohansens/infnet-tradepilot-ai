'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FiMoon, FiSun } from 'react-icons/fi';
import { MIN_PASSWORD_LENGTH } from '@tradepilot/shared';
import { useAppTheme } from '@/components/ThemeProvider';
import {
  ApiClientError,
  registerAccount,
  saveAuthTokens,
} from '@/lib/apiClient';

/**
 * Tela de Cadastro no estilo split hero do Taometria (`.auth-shell`),
 * com senha forte (>= 10 caracteres) e consentimento LGPD obrigatório.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-12
 * @rnf RNF-13
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function CadastroPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useAppTheme();
  const isDark = theme === 'dracula';

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
      setErrorMessage(`A senha deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`);
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

      <div className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <section className="desk-panel space-y-5 p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-profit">
            Onboarding em menos de 3 minutos
          </p>
          <h1 className="text-4xl font-black leading-tight tracking-tight">
            Comece importando seu extrato ou explore a base demo.
          </h1>
          <p className="text-sm text-[var(--app-muted)]">
            Sem planilhas manuais. Assim que criar sua conta, você já pode subir seu CSV/XLSX da B3 ou do Profit ou testar instantaneamente com 45 operações demonstrativas.
          </p>
          <ul className="space-y-2 text-sm text-[var(--app-muted)]">
            <li>✓ Isolamento individual de dados por conta no banco (RLS)</li>
            <li>✓ Exportação completa em ZIP (JSON + CSV) e exclusão LGPD</li>
            <li>✓ Trilha de auditoria imutável para todas as alterações</li>
          </ul>
        </section>

        <section className="ui-panel p-8">
          <header className="mb-5 space-y-1">
            <h2 className="text-2xl font-bold">Criar conta</h2>
            <p className="text-sm text-[var(--app-muted)]">
              Preencha seus dados básicos para acessar o onboarding invertido.
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

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="register-name" className="mb-1.5 block text-xs font-semibold text-[var(--app-muted)]">
                Nome completo
              </label>
              <input
                id="register-name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex.: Rafael Silva"
                className="ui-input"
              />
            </div>

            <div>
              <label htmlFor="register-email" className="mb-1.5 block text-xs font-semibold text-[var(--app-muted)]">
                E-mail
              </label>
              <input
                id="register-email"
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
              <label htmlFor="register-password" className="mb-1.5 block text-xs font-semibold text-[var(--app-muted)]">
                Senha (mínimo {MIN_PASSWORD_LENGTH} caracteres)
              </label>
              <input
                id="register-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Crie uma senha forte"
                className="ui-input"
              />
              <p
                className={`mt-1.5 text-xs ${
                  password.length === 0
                    ? 'text-[var(--app-muted)]'
                    : passwordLongEnough
                      ? 'text-profit'
                      : 'text-fiscal'
                }`}
              >
                {passwordLongEnough
                  ? 'Requisito mínimo de 10 caracteres atendido.'
                  : `Faltam ${Math.max(0, MIN_PASSWORD_LENGTH - password.length)} caracteres.`}
              </p>
            </div>

            <div className="ui-panel-soft p-3.5">
              <label htmlFor="register-lgpd" className="flex cursor-pointer items-start gap-3 text-xs text-[var(--app-muted)]">
                <input
                  id="register-lgpd"
                  type="checkbox"
                  required
                  checked={lgpdConsent}
                  onChange={(e) => setLgpdConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  Concordo com o tratamento dos meus dados operacionais e fiscais conforme a{' '}
                  <strong className="text-[var(--app-text)]">LGPD (Lei 13.709/2018)</strong>, com direito à exportação integral e exclusão definitiva.
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="ui-button-primary w-full disabled:opacity-60"
            >
              {submitting ? 'Criando conta...' : 'Criar conta e ir ao Onboarding'}
            </button>
          </form>

          <footer className="mt-6 border-t border-[var(--app-line)] pt-5 text-center text-sm text-[var(--app-muted)]">
            Já possui conta?{' '}
            <Link href="/login" className="font-semibold text-profit hover:underline">
              Fazer login
            </Link>
          </footer>
        </section>
      </div>
    </main>
  );
}
