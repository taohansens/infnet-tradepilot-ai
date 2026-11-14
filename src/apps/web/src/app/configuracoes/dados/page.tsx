'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ACCOUNT_DELETE_CONFIRMATION_PHRASE } from '@tradepilot/shared';
import {
  ApiClientError,
  clearAuthTokens,
  deletePrivacyAccount,
  downloadPrivacyExportZip,
  fetchAuditLogs,
  getAccessToken,
  requestPrivacyExport,
  type AuditLogListItem,
} from '@/lib/apiClient';
import AppShell from '@/components/AppShell';
import InstrumentSettingsPanel from '@/components/InstrumentSettingsPanel';

/**
 * Painel de Soberania de Dados (LGPD) e Trilha de Auditoria Imutável:
 * - FN-PLT-04: Exportação Completa (.ZIP com JSON + CSV)
 * - FN-PLT-05: Exclusão Definitiva de Conta com confirmação dupla
 * - FN-PLT-06: Visualização da Trilha de Auditoria Append-Only
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-13
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-30
 */
export default function ConfiguracoesDadosPage() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean>(true);

  // Estado da exportação LGPD (FN-PLT-04)
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // Estado da trilha de auditoria (FN-PLT-06)
  const [auditLogs, setAuditLogs] = useState<AuditLogListItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  // Estado do modal de exclusão dupla (FN-PLT-05)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [confirmationPhrase, setConfirmationPhrase] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadAuditLogs = useCallback(async () => {
    setLoadingLogs(true);
    setLogsError(null);
    try {
      const data = await fetchAuditLogs(30);
      setAuditLogs(data.items);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setHasSession(false);
        return;
      }
      setLogsError(
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar a trilha de auditoria.',
      );
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      setHasSession(false);
      return;
    }
    void loadAuditLogs();
  }, [loadAuditLogs]);

  useEffect(() => {
    if (!deleteModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDeleteModalOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteModalOpen]);

  async function handleRequestExport() {
    setExporting(true);
    setExportError(null);
    setExportStatus(null);
    setDownloadUrl(null);

    try {
      const job = await requestPrivacyExport();
      setExportStatus(
        `Pacote LGPD gerado com sucesso (Job ${job.job_id.slice(0, 8)}…). O link temporário permanece disponível por 15 minutos.`,
      );
      if (job.download_url) {
        setDownloadUrl(job.download_url);
      }
      await loadAuditLogs();
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : 'Erro ao gerar exportação de dados.',
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleDownloadZip() {
    if (!downloadUrl) return;
    setExportError(null);
    try {
      const blob = await downloadPrivacyExportZip(downloadUrl);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `tradepilot-dados-lgpd-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'Falha ao baixar o arquivo ZIP.',
      );
    }
  }

  async function handleConfirmDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeleteError(null);

    if (confirmationPhrase !== ACCOUNT_DELETE_CONFIRMATION_PHRASE) {
      setDeleteError(
        `Digite exatamente "${ACCOUNT_DELETE_CONFIRMATION_PHRASE}" para prosseguir.`,
      );
      return;
    }

    setDeleting(true);
    try {
      await deletePrivacyAccount({
        confirmation_phrase: confirmationPhrase,
        password: deletePassword,
      });
      clearAuthTokens();
      setDeleteModalOpen(false);
      router.push('/login');
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : 'Não foi possível concluir a exclusão da conta.',
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AppShell subtitle="Soberania de Dados (LGPD) & Auditoria">
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-profit">
            Configurações · Privacidade &amp; LGPD
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-white">
            Soberania de Dados e Auditoria
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Exporte seu histórico em formato aberto (JSON/CSV), audite alterações imutáveis ou exerça seu direito de exclusão definitiva (Lei 13.709/2018).
          </p>
        </div>

        <nav aria-label="Navegação rápida" className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Início
          </Link>
          <Link
            href="/login"
            onClick={() => clearAuthTokens()}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Sair
          </Link>
        </nav>
      </header>

      {!hasSession && (
        <section
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100"
        >
          <p className="font-medium">Sessão não autenticada.</p>
          <p className="mt-1 text-amber-200">
            Para exportar seus dados, consultar sua trilha de auditoria ou excluir sua conta, faça login primeiro.
          </p>
          <div className="mt-3 flex gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
            >
              Ir para /login
            </Link>
            <Link
              href="/cadastro"
              className="rounded-lg border border-amber-400/50 px-4 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
            >
              Criar conta em /cadastro
            </Link>
          </div>
        </section>
      )}

      {/* Seção 0: Configurações de Contratos & Custos B3 (Taometria / SPEC-06) */}
      {hasSession && <InstrumentSettingsPanel />}

      {/* Seção 1: Exportação Completa LGPD (SPEC-03 / FN-PLT-04) */}
      <section
        aria-labelledby="export-heading"
        className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <h2 id="export-heading" className="text-lg font-semibold text-white">
              Exportação Completa de Dados (LGPD)
            </h2>
            <p className="text-sm text-slate-300">
              Gera um pacote <code className="text-slate-100">.zip</code> contendo arquivos{' '}
              <code className="text-slate-100">JSON</code> e{' '}
              <code className="text-slate-100">CSV</code> com seu perfil, trades, importações e trilha de auditoria, preservando precisão decimal exata.
            </p>
          </div>

          <button
            type="button"
            onClick={handleRequestExport}
            disabled={exporting || !hasSession}
            className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? 'Gerando pacote ZIP...' : 'Exportar Meus Dados (.ZIP)'}
          </button>
        </div>

        {exportStatus && (
          <div
            role="status"
            aria-live="polite"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100"
          >
            <span>{exportStatus}</span>
            {downloadUrl && (
              <button
                type="button"
                onClick={handleDownloadZip}
                className="rounded-md bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
              >
                Baixar arquivo .ZIP
              </button>
            )}
          </div>
        )}

        {exportError && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {exportError}
          </div>
        )}
      </section>

      {/* Seção 2: Trilha de Auditoria Imutável (SPEC-04 / FN-PLT-06) */}
      <section
        aria-labelledby="audit-heading"
        className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="audit-heading" className="text-lg font-semibold text-white">
              Trilha de Auditoria Transacional (Append-Only)
            </h2>
            <p className="mt-1 text-sm text-slate-300">
              Registro imutável de alterações manuais, conciliações, ajustes fiscais e solicitações de privacidade (LGPD).
            </p>
          </div>
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-fiscal">
            Imutável · Sem UPDATE/DELETE
          </span>
        </div>

        {logsError && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {logsError}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-950 text-xs uppercase text-slate-300">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Data/Hora (UTC)
                </th>
                <th scope="col" className="px-4 py-3">
                  Ação
                </th>
                <th scope="col" className="px-4 py-3">
                  Entidade
                </th>
                <th scope="col" className="px-4 py-3">
                  ID da Entidade
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-200">
              {loadingLogs ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Carregando registros imutáveis...
                  </td>
                </tr>
              ) : auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    Nenhum evento registrado ainda na sua trilha de auditoria.
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface-800/50">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-300">
                      {new Date(log.createdAtUtc).toLocaleString('pt-BR', {
                        timeZone: 'UTC',
                      })}{' '}
                      UTC
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-profit">
                      {log.action}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">
                      {log.entityType}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {log.entityId}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Seção 3: Zona de Perigo — Exclusão Definitiva de Conta (SPEC-03 / FN-PLT-05) */}
      <section
        aria-labelledby="danger-heading"
        className="rounded-2xl border border-red-500/40 bg-red-950/20 p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <h2 id="danger-heading" className="text-lg font-semibold text-loss">
              Exclusão Definitiva de Conta (LGPD)
            </h2>
            <p className="text-sm text-slate-300">
              Esta ação é <strong className="text-white">irreversível</strong>. Todos os seus dados pessoais, operações, importações e anexos serão removidos permanentemente, preservando apenas o registro mínimo anonimizado exigido por lei na trilha de auditoria.
            </p>
          </div>

          <button
            type="button"
            disabled={!hasSession}
            onClick={() => {
              setDeleteError(null);
              setConfirmationPhrase('');
              setDeletePassword('');
              setDeleteModalOpen(true);
            }}
            className="rounded-lg border border-red-500 bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Excluir Minha Conta
          </button>
        </div>
      </section>

      {/* Modal de Confirmação Dupla (WCAG 2.1 AA) */}
      {deleteModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-modal-title"
          aria-describedby="delete-modal-description"
        >
          <div className="w-full max-w-md rounded-2xl border border-red-500/50 bg-surface-900 p-6 shadow-2xl">
            <h3
              id="delete-modal-title"
              className="text-xl font-semibold text-white"
            >
              Confirmar exclusão definitiva
            </h3>
            <p
              id="delete-modal-description"
              className="mt-2 text-sm text-slate-300"
            >
              Para confirmar que deseja apagar sua conta permanentemente, digite{' '}
              <code className="rounded bg-surface-950 px-1.5 py-0.5 font-semibold text-red-300">
                {ACCOUNT_DELETE_CONFIRMATION_PHRASE}
              </code>{' '}
              e informe sua senha atual.
            </p>

            {deleteError && (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-200"
              >
                {deleteError}
              </div>
            )}

            <form onSubmit={handleConfirmDelete} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="delete-phrase"
                  className="mb-1.5 block text-sm font-medium text-slate-200"
                >
                  Frase de confirmação
                </label>
                <input
                  id="delete-phrase"
                  type="text"
                  required
                  autoComplete="off"
                  value={confirmationPhrase}
                  onChange={(e) => setConfirmationPhrase(e.target.value)}
                  placeholder={ACCOUNT_DELETE_CONFIRMATION_PHRASE}
                  className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus-visible:border-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                />
              </div>

              <div>
                <label
                  htmlFor="delete-password"
                  className="mb-1.5 block text-sm font-medium text-slate-200"
                >
                  Senha atual
                </label>
                <input
                  id="delete-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="Digite sua senha atual"
                  className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus-visible:border-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setDeleteModalOpen(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={
                    deleting ||
                    confirmationPhrase !== ACCOUNT_DELETE_CONFIRMATION_PHRASE ||
                    deletePassword.length === 0
                  }
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deleting ? 'Excluindo...' : 'Confirmar exclusão irreversível'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
    </AppShell>
  );
}
