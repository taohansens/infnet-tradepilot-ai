'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  formatBrl,
  type CommitIngestionJobResponse,
  type ConciliationAction,
  type IngestionJobDetailResponse,
  type StagingItemPreview,
  type UploadSourceHint,
} from '@tradepilot/shared';
import {
  ApiClientError,
  commitIngestionJob,
  fetchIngestionJob,
  getAccessToken,
  uploadIngestionFile,
} from '@/lib/apiClient';
import AppShell from '@/components/AppShell';

/**
 * Wizard de Importação Assíncrona e Conciliação Assistida (`/diario/importar`).
 * - Dropzone CSV/XLSX (Extrato B3 "Negociação de Ativos" e Ordens do Profit)
 * - Barra de progresso em tempo real do processamento em staging (ADR-01)
 * - Passo condicional "Conflitos de Conciliação" lado a lado (Lacuna 1 do TP2)
 *   com ações explícitas: IGNORE, OVERWRITE e MERGE_COSTS.
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-30
 */

const ACTION_LABELS: Record<
  ConciliationAction,
  { title: string; description: string }
> = {
  IGNORE: {
    title: 'Ignorar duplicata',
    description: 'Mantém a operação atual no Diário sem alterações.',
  },
  MERGE_COSTS: {
    title: 'Mesclar custos',
    description: 'Mantém o trade atual e incorpora taxas e IRRF do arquivo.',
  },
  OVERWRITE: {
    title: 'Sobrescrever',
    description: 'Substitui os dados da operação existente pelos do arquivo.',
  },
};

function formatFieldLabel(field: string): string {
  if (field === 'fees') return 'Taxas / Corretagem';
  if (field === 'irrf') return 'IRRF';
  return field;
}

export default function DiarioImportarPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [hasSession, setHasSession] = useState(true);
  const [sourceHint, setSourceHint] = useState<UploadSourceHint>('B3_CSV');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<IngestionJobDetailResponse | null>(
    null,
  );
  const [resolutions, setResolutions] = useState<
    Record<string, ConciliationAction>
  >({});

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] =
    useState<CommitIngestionJobResponse | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      setHasSession(false);
    }
  }, []);

  const initializeDefaultResolutions = useCallback(
    (detail: IngestionJobDetailResponse) => {
      setResolutions((prev) => {
        const next = { ...prev };
        for (const item of detail.items) {
          if (item.dedup_status !== 'NEW' && !next[item.staging_item_id]) {
            next[item.staging_item_id] =
              item.recommended_action ??
              (item.dedup_status === 'CONFLICT' ? 'MERGE_COSTS' : 'IGNORE');
          }
        }
        return next;
      });
    },
    [],
  );

  // Polling assíncrono enquanto o job estiver QUEUED ou PROCESSING (ADR-01)
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (!jobId || !active) return;
      try {
        const detail = await fetchIngestionJob(jobId);
        if (!active) return;
        setJobDetail(detail);

        if (detail.status === 'AWAITING_REVIEW') {
          initializeDefaultResolutions(detail);
          return;
        }

        if (detail.status === 'QUEUED' || detail.status === 'PROCESSING') {
          timer = setTimeout(() => {
            void poll();
          }, 800);
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiClientError && error.status === 401) {
          setHasSession(false);
          return;
        }
        setUploadError(
          error instanceof Error
            ? error.message
            : 'Erro ao acompanhar o progresso da importação.',
        );
      }
    }

    void poll();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, initializeDefaultResolutions]);

  const conflictItems = useMemo(
    () =>
      (jobDetail?.items ?? []).filter(
        (item) =>
          item.dedup_status === 'CONFLICT' ||
          item.dedup_status === 'EXACT_DUPLICATE',
      ),
    [jobDetail],
  );

  const newItems = useMemo(
    () =>
      (jobDetail?.items ?? []).filter((item) => item.dedup_status === 'NEW'),
    [jobDetail],
  );

  const hasConflictsOrDuplicates = conflictItems.length > 0;

  function handleFileSelected(file: File | null) {
    setUploadError(null);
    setCommitError(null);
    setCommitResult(null);
    setSelectedFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const droppedFile = event.dataTransfer.files?.[0] ?? null;
    if (droppedFile) {
      handleFileSelected(droppedFile);
    }
  }

  async function handleStartUpload() {
    if (!selectedFile) {
      setUploadError('Selecione um arquivo CSV ou XLSX antes de enviar.');
      return;
    }

    setUploading(true);
    setUploadError(null);
    setCommitError(null);
    setCommitResult(null);
    setJobDetail(null);
    setResolutions({});

    try {
      const queued = await uploadIngestionFile(selectedFile, sourceHint);
      setJobId(queued.job_id);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setHasSession(false);
      }
      setUploadError(
        error instanceof Error
          ? error.message
          : 'Não foi possível iniciar a importação.',
      );
    } finally {
      setUploading(false);
    }
  }

  function handleResetWizard() {
    setSelectedFile(null);
    setJobId(null);
    setJobDetail(null);
    setResolutions({});
    setUploadError(null);
    setCommitError(null);
    setCommitResult(null);
  }

  async function handleCommit() {
    if (!jobDetail) return;
    setCommitting(true);
    setCommitError(null);

    try {
      const payload = {
        resolutions: conflictItems.map((item) => ({
          staging_item_id: item.staging_item_id,
          action:
            resolutions[item.staging_item_id] ??
            (item.dedup_status === 'CONFLICT' ? 'MERGE_COSTS' : 'IGNORE'),
        })),
      };

      const committed = await commitIngestionJob(jobDetail.job_id, payload);
      setCommitResult(committed);
      setJobDetail((prev) =>
        prev ? { ...prev, status: 'COMMITTED' } : prev,
      );
    } catch (error) {
      setCommitError(
        error instanceof Error
          ? error.message
          : 'Não foi possível concluir a conciliação.',
      );
    } finally {
      setCommitting(false);
    }
  }

  return (
    <AppShell subtitle="Importação Assíncrona & Conciliação">
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-profit">
            Diário de Trade · Ingestão Assíncrona &amp; Conciliação
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-white">
            Importar Extrato B3 ou Ordens do Profit
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300">
            Envie seu arquivo CSV ou XLSX para detecção automática de duplicatas por hash SHA-256 e conciliação assistida antes de salvar no Diário.
          </p>
        </div>

        <nav aria-label="Navegação do Diário" className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Início
          </Link>
          <Link
            href="/configuracoes/dados"
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Auditoria &amp; LGPD
          </Link>
        </nav>
      </header>

      {!hasSession && (
        <section
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100"
        >
          <p className="font-medium">Faça login para importar seus arquivos.</p>
          <p className="mt-1 text-amber-200">
            Cada importação é isolada na sua conta via PostgreSQL Row-Level Security (RNF-11).
          </p>
          <Link
            href="/login"
            className="mt-3 inline-block rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
          >
            Ir para /login
          </Link>
        </section>
      )}

      {/* Passo 1: Seleção de origem + Dropzone */}
      <section
        aria-labelledby="step-upload-heading"
        className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="step-upload-heading"
              className="text-lg font-semibold text-white"
            >
              1. Selecione a origem e envie o arquivo
            </h2>
            <p className="text-sm text-slate-400">
              Aceita arquivos <code className="text-slate-200">.csv</code> e{' '}
              <code className="text-slate-200">.xlsx</code> até 15 MB.
            </p>
          </div>
          {jobDetail && (
            <button
              type="button"
              onClick={handleResetWizard}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Nova importação
            </button>
          )}
        </div>

        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-medium text-slate-200">
            Padrão do arquivo
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                {
                  id: 'B3_CSV',
                  title: 'Extrato B3 — Negociação de Ativos',
                  subtitle: 'Exportação da Área do Investidor B3 (CSV ou XLSX)',
                },
                {
                  id: 'PROFIT_CSV',
                  title: 'Ordens do Profit (Nelogica)',
                  subtitle: 'Relatório de ordens/operações exportado do Profit',
                },
              ] as const
            ).map((option) => {
              const selected = sourceHint === option.id;
              return (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition ${
                    selected
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-slate-800 bg-surface-950 hover:border-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="source_hint"
                    value={option.id}
                    checked={selected}
                    onChange={() => setSourceHint(option.id)}
                    className="mt-1 h-4 w-4 text-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-400"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-white">
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-400">
                      {option.subtitle}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Dropzone acessível */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
            dragging
              ? 'border-emerald-400 bg-emerald-500/10'
              : 'border-slate-700 bg-surface-950 hover:border-slate-500'
          }`}
        >
          <input
            ref={fileInputRef}
            id="ingestion-file-input"
            type="file"
            accept=".csv,.xlsx,.xls"
            className="sr-only"
            onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
          />
          <p className="text-sm font-medium text-slate-100">
            Arraste e solte seu extrato aqui
          </p>
          <p className="mt-1 text-xs text-slate-400">
            ou selecione um arquivo do seu computador (.CSV / .XLSX)
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 rounded-lg border border-slate-600 bg-surface-900 px-4 py-2 text-xs font-semibold text-white hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            Escolher arquivo
          </button>

          {selectedFile && (
            <p className="mt-4 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1 text-xs font-medium text-profit">
              Arquivo selecionado: {selectedFile.name} (
              {(selectedFile.size / 1024).toFixed(1)} KB)
            </p>
          )}
        </div>

        {uploadError && (
          <div
            role="alert"
            aria-live="assertive"
            className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {uploadError}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            disabled={!selectedFile || uploading || !hasSession}
            onClick={handleStartUpload}
            className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading
              ? 'Enviando arquivo...'
              : 'Enviar para Processamento Assíncrono'}
          </button>
        </div>
      </section>

      {/* Passo 2: Barra de Progresso do Job Assíncrono (ADR-01) */}
      {jobDetail && (
        <section
          aria-labelledby="step-progress-heading"
          className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="step-progress-heading"
                className="text-lg font-semibold text-white"
              >
                2. Processamento em Staging ({jobDetail.file_name})
              </h2>
              <p className="text-xs text-slate-400">
                Job <code className="text-slate-300">{jobDetail.job_id}</code>
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                jobDetail.status === 'FAILED'
                  ? 'border border-red-500/40 bg-red-500/10 text-loss'
                  : jobDetail.status === 'COMMITTED'
                    ? 'border border-emerald-500/40 bg-emerald-500/10 text-profit'
                    : 'border border-amber-500/40 bg-amber-500/10 text-fiscal'
              }`}
            >
              {jobDetail.status === 'QUEUED' && 'Na fila'}
              {jobDetail.status === 'PROCESSING' && 'Processando extrato...'}
              {jobDetail.status === 'AWAITING_REVIEW' && 'Pronto para revisão'}
              {jobDetail.status === 'COMMITTED' && 'Importação concluída'}
              {jobDetail.status === 'FAILED' && 'Falha na validação'}
            </span>
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-xs text-slate-300">
              <span>Progresso da análise e deduplicação</span>
              <span>{jobDetail.progress_pct}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Progresso da importação"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={jobDetail.progress_pct}
              className="h-2.5 w-full overflow-hidden rounded-full bg-surface-950"
            >
              <div
                className={`h-full transition-all duration-300 ${
                  jobDetail.status === 'FAILED'
                    ? 'bg-red-500'
                    : 'bg-emerald-500'
                }`}
                style={{ width: `${jobDetail.progress_pct}%` }}
              />
            </div>
          </div>

          {jobDetail.status === 'FAILED' && jobDetail.error_message_ptbr && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              {jobDetail.error_message_ptbr}
            </div>
          )}

          {jobDetail.status !== 'FAILED' &&
            jobDetail.status !== 'QUEUED' &&
            jobDetail.status !== 'PROCESSING' && (
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-surface-950 p-4">
                  <p className="text-xs text-slate-400">Novas operações</p>
                  <p className="mt-1 text-2xl font-semibold text-profit">
                    {jobDetail.summary.new_count}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-surface-950 p-4">
                  <p className="text-xs text-slate-400">Duplicatas exatas</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-200">
                    {jobDetail.summary.exact_duplicate_count}
                  </p>
                </div>
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <p className="text-xs text-amber-200">
                    Conflitos de conciliação
                  </p>
                  <p className="mt-1 text-2xl font-semibold text-fiscal">
                    {jobDetail.summary.conflict_count}
                  </p>
                </div>
              </div>
            )}
        </section>
      )}

      {/* Passo 3 Condicional: Conflitos de Conciliação Lado a Lado (Lacuna 1 TP2) */}
      {jobDetail && jobDetail.status === 'AWAITING_REVIEW' && (
        <section
          aria-labelledby="step-review-heading"
          className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
        >
          <header className="mb-5">
            <h2
              id="step-review-heading"
              className="text-lg font-semibold text-white"
            >
              {hasConflictsOrDuplicates
                ? '3. Conflitos de Conciliação (Revisão Lado a Lado)'
                : '3. Prévia Resumida — Pronto para Confirmar em 1 Clique'}
            </h2>
            <p className="mt-1 text-sm text-slate-300">
              {hasConflictsOrDuplicates
                ? 'Detectamos operações já existentes no seu Diário. Compare lado a lado e escolha como conciliar cada item antes de salvar.'
                : `Nenhum conflito ou duplicata encontrado. ${newItems.length} nova(s) operação(ões) serão gravadas atomicamente no seu Diário.`}
            </p>
          </header>

          {hasConflictsOrDuplicates && (
            <div className="space-y-4">
              {conflictItems.map((item) => (
                <ConflictComparisonCard
                  key={item.staging_item_id}
                  item={item}
                  selectedAction={
                    resolutions[item.staging_item_id] ??
                    (item.dedup_status === 'CONFLICT'
                      ? 'MERGE_COSTS'
                      : 'IGNORE')
                  }
                  onChangeAction={(action) =>
                    setResolutions((prev) => ({
                      ...prev,
                      [item.staging_item_id]: action,
                    }))
                  }
                />
              ))}
            </div>
          )}

          {newItems.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">
                Novas operações a inserir ({newItems.length})
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-950 uppercase text-slate-400">
                    <tr>
                      <th scope="col" className="px-3 py-2.5">
                        Linha
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        Ativo
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        Lado
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        Qtd
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        Preço
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        Taxas
                      </th>
                      <th scope="col" className="px-3 py-2.5">
                        IRRF
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-200">
                    {newItems.slice(0, 10).map((item) => (
                      <tr key={item.staging_item_id}>
                        <td className="px-3 py-2 font-mono text-slate-400">
                          #{item.row_number}
                        </td>
                        <td className="px-3 py-2 font-semibold text-white">
                          {item.ticker}
                        </td>
                        <td className="px-3 py-2">
                          {item.side === 'BUY' ? 'Compra' : 'Venda'}
                        </td>
                        <td className="px-3 py-2 font-mono">{item.qty}</td>
                        <td className="px-3 py-2 font-mono">
                          {formatBrl(item.price)}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {formatBrl(item.fees)}
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {formatBrl(item.irrf)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {newItems.length > 10 && (
                <p className="mt-2 text-xs text-slate-400">
                  Exibindo 10 de {newItems.length} novas operações.
                </p>
              )}
            </div>
          )}

          {commitError && (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              {commitError}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-800 pt-5">
            <button
              type="button"
              onClick={handleResetWizard}
              className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={committing}
              onClick={handleCommit}
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing
                ? 'Salvando transação atômica...'
                : 'Confirmar e Salvar no Diário'}
            </button>
          </div>
        </section>
      )}

      {/* Confirmação pós-commit */}
      {commitResult && (
        <section
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6"
        >
          <h2 className="text-lg font-semibold text-profit">
            Importação confirmada em transação atômica!
          </h2>
          <p className="mt-1 text-sm text-slate-200">
            Todas as decisões de conciliação foram gravadas na trilha de auditoria imutável (`audit_logs`).
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-surface-950/70 p-3">
              <dt className="text-xs text-slate-400">Inseridos</dt>
              <dd className="text-xl font-semibold text-profit">
                {commitResult.inserted}
              </dd>
            </div>
            <div className="rounded-lg bg-surface-950/70 p-3">
              <dt className="text-xs text-slate-400">Custos mesclados</dt>
              <dd className="text-xl font-semibold text-fiscal">
                {commitResult.merged}
              </dd>
            </div>
            <div className="rounded-lg bg-surface-950/70 p-3">
              <dt className="text-xs text-slate-400">Sobrescritos</dt>
              <dd className="text-xl font-semibold text-white">
                {commitResult.overwritten}
              </dd>
            </div>
            <div className="rounded-lg bg-surface-950/70 p-3">
              <dt className="text-xs text-slate-400">Ignorados</dt>
              <dd className="text-xl font-semibold text-slate-300">
                {commitResult.ignored}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handleResetWizard}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
            >
              Importar outro arquivo
            </button>
            <Link
              href="/configuracoes/dados"
              className="rounded-lg border border-emerald-400/50 px-4 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/20"
            >
              Ver trilha de auditoria
            </Link>
          </div>
        </section>
      )}
    </div>
    </AppShell>
  );
}

function ConflictComparisonCard({
  item,
  selectedAction,
  onChangeAction,
}: {
  item: StagingItemPreview;
  selectedAction: ConciliationAction;
  onChangeAction: (action: ConciliationAction) => void;
}) {
  const isConflict = item.dedup_status === 'CONFLICT';
  const feesDiverge = item.diff_fields.includes('fees');
  const irrfDiverge = item.diff_fields.includes('irrf');

  return (
    <article
      className={`rounded-xl border p-5 ${
        isConflict
          ? 'border-amber-500/50 bg-amber-500/5'
          : 'border-slate-700 bg-surface-950'
      }`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-400">
            Linha #{item.row_number}
          </span>
          <span className="text-base font-semibold text-white">
            {item.ticker}
          </span>
          <span className="rounded bg-surface-800 px-2 py-0.5 text-xs text-slate-200">
            {item.side === 'BUY' ? 'Compra' : 'Venda'} · Qtd {item.qty}
          </span>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            isConflict
              ? 'bg-amber-500/20 text-fiscal'
              : 'bg-slate-800 text-slate-300'
          }`}
        >
          {isConflict
            ? `Conflito em: ${item.diff_fields.map(formatFieldLabel).join(', ')}`
            : 'Duplicata exata'}
        </span>
      </div>

      {/* Comparação lado a lado: Existente vs Importado */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-surface-900 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Existente no Diário
          </h4>
          {item.matched_trade ? (
            <dl className="mt-2 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-slate-400">Origem / Corretora</dt>
                <dd className="text-slate-200">
                  {item.matched_trade.source} ·{' '}
                  {item.matched_trade.broker ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-400">Preço</dt>
                <dd className="font-mono text-slate-100">
                  {formatBrl(item.matched_trade.entry_price)}
                </dd>
              </div>
              <div
                className={`flex justify-between rounded px-1.5 py-0.5 ${
                  feesDiverge ? 'bg-amber-500/15 text-amber-200' : ''
                }`}
              >
                <dt className="text-slate-300">Taxas</dt>
                <dd className="font-mono font-semibold">
                  {formatBrl(item.matched_trade.fees)}
                </dd>
              </div>
              <div
                className={`flex justify-between rounded px-1.5 py-0.5 ${
                  irrfDiverge ? 'bg-amber-500/15 text-amber-200' : ''
                }`}
              >
                <dt className="text-slate-300">IRRF</dt>
                <dd className="font-mono font-semibold">
                  {formatBrl(item.matched_trade.irrf)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-slate-400">
              Duplicata detectada dentro do próprio arquivo enviado.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-emerald-500/30 bg-surface-900 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-profit">
            Importado do Arquivo
          </h4>
          <dl className="mt-2 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <dt className="text-slate-400">Corretora</dt>
              <dd className="text-slate-200">{item.broker ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-400">Preço</dt>
              <dd className="font-mono text-slate-100">
                {formatBrl(item.price)}
              </dd>
            </div>
            <div
              className={`flex justify-between rounded px-1.5 py-0.5 ${
                feesDiverge ? 'bg-amber-500/15 text-amber-200' : ''
              }`}
            >
              <dt className="text-slate-300">Taxas</dt>
              <dd className="font-mono font-semibold">
                {formatBrl(item.fees)}
              </dd>
            </div>
            <div
              className={`flex justify-between rounded px-1.5 py-0.5 ${
                irrfDiverge ? 'bg-amber-500/15 text-amber-200' : ''
              }`}
            >
              <dt className="text-slate-300">IRRF</dt>
              <dd className="font-mono font-semibold">
                {formatBrl(item.irrf)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Ações explícitas de resolução */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-semibold text-slate-300">
          Ação de conciliação para a linha #{item.row_number}
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(['IGNORE', 'MERGE_COSTS', 'OVERWRITE'] as const).map((action) => {
            const active = selectedAction === action;
            return (
              <label
                key={action}
                className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-xs transition ${
                  active
                    ? 'border-emerald-500 bg-emerald-500/15 text-white'
                    : 'border-slate-800 bg-surface-900 text-slate-300 hover:border-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name={`resolution-${item.staging_item_id}`}
                  value={action}
                  checked={active}
                  onChange={() => onChangeAction(action)}
                  className="mt-0.5 h-3.5 w-3.5 text-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-400"
                />
                <span>
                  <span className="block font-semibold">
                    {ACTION_LABELS[action].title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-slate-400">
                    {ACTION_LABELS[action].description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </article>
  );
}
