'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import type {
  CommitIngestionJobResponse,
  ConciliationAction,
  IngestionJobDetailResponse,
  UploadSourceHint,
} from '@tradepilot/shared';
import {
  ApiClientError,
  commitIngestionJob,
  completeOnboarding,
  fetchIngestionJob,
  getAccessToken,
  seedOnboardingDemo,
  uploadIngestionFile,
} from '@/lib/apiClient';

/**
 * Onboarding Guiado Invertido ("Value First" + Base Demonstrativa, meta < 3 min).
 * Stepper de 3 passos:
 *   1. Upload de Extrato B3/Profit OU botão "Explorar Base Demonstrativa" (45 trades)
 *   2. Prévia e Conciliação Rápida
 *   3. Primeiro Diagnóstico Revelado e redirecionamento para /dashboard
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-25
 */

type OnboardingStep = 1 | 2 | 3;

const STEPS: Array<{ step: OnboardingStep; title: string; subtitle: string }> = [
  {
    step: 1,
    title: '1. Origem dos Dados',
    subtitle: 'Suba seu extrato B3/Profit ou use a base demonstrativa',
  },
  {
    step: 2,
    title: '2. Prévia e Conciliação',
    subtitle: 'Validação rápida e resolução de eventuais conflitos',
  },
  {
    step: 3,
    title: '3. Primeiro Diagnóstico',
    subtitle: 'Redirecionamento imediato para o seu Dashboard',
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [hasSession, setHasSession] = useState(true);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(1);

  // Passo 1: Upload ou Base Demo
  const [sourceHint, setSourceHint] = useState<UploadSourceHint>('B3_CSV');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busyAction, setBusyAction] = useState<'upload' | 'demo' | 'commit' | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Passo 2: Job em staging + conciliação rápida
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<IngestionJobDetailResponse | null>(
    null,
  );
  const [resolutions, setResolutions] = useState<
    Record<string, ConciliationAction>
  >({});

  // Passo 3: Diagnóstico revelado
  const [diagnosisSummary, setDiagnosisSummary] = useState<{
    mode: 'demo' | 'real';
    tradesCount: number;
    redirectTo: string;
    commitResult?: CommitIngestionJobResponse;
  } | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      setHasSession(false);
    }
  }, []);

  // Polling do job durante o Passo 2
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
          const defaults: Record<string, ConciliationAction> = {};
          for (const item of detail.items) {
            if (item.dedup_status !== 'NEW') {
              defaults[item.staging_item_id] =
                item.recommended_action ??
                (item.dedup_status === 'CONFLICT' ? 'MERGE_COSTS' : 'IGNORE');
            }
          }
          setResolutions(defaults);
          return;
        }

        if (detail.status === 'QUEUED' || detail.status === 'PROCESSING') {
          timer = setTimeout(() => {
            void poll();
          }, 700);
        }
      } catch (error) {
        if (!active) return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Erro ao consultar o processamento do arquivo.',
        );
      }
    }

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    if (file) {
      setSelectedFile(file);
      setErrorMessage(null);
    }
  }

  async function handleStartUpload() {
    if (!selectedFile) {
      setErrorMessage('Selecione um arquivo CSV ou XLSX do Extrato B3 ou Profit.');
      return;
    }

    setBusyAction('upload');
    setErrorMessage(null);
    try {
      const queued = await uploadIngestionFile(selectedFile, sourceHint);
      setJobId(queued.job_id);
      setCurrentStep(2);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setHasSession(false);
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Não foi possível enviar o arquivo.',
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExploreDemo() {
    setBusyAction('demo');
    setErrorMessage(null);
    try {
      const seeded = await seedOnboardingDemo();
      setDiagnosisSummary({
        mode: 'demo',
        tradesCount: seeded.seeded_trades,
        redirectTo: seeded.redirect_to,
      });
      setCurrentStep(3);
      setTimeout(() => {
        router.push(seeded.redirect_to);
      }, 1500);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setHasSession(false);
      }
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Não foi possível gerar a base demonstrativa.',
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleConfirmQuickConciliation() {
    if (!jobDetail) return;
    setBusyAction('commit');
    setErrorMessage(null);

    try {
      const conflictOrDup = jobDetail.items.filter(
        (i) => i.dedup_status !== 'NEW',
      );
      const commitResult = await commitIngestionJob(jobDetail.job_id, {
        resolutions: conflictOrDup.map((item) => ({
          staging_item_id: item.staging_item_id,
          action:
            resolutions[item.staging_item_id] ??
            (item.dedup_status === 'CONFLICT' ? 'MERGE_COSTS' : 'IGNORE'),
        })),
      });

      const completed = await completeOnboarding();
      setDiagnosisSummary({
        mode: 'real',
        tradesCount:
          commitResult.inserted + commitResult.merged + commitResult.overwritten,
        redirectTo: completed.redirect_to,
        commitResult,
      });
      setCurrentStep(3);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Erro ao confirmar a importação no Diário.',
      );
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl space-y-8 px-6 py-12">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-profit">
          Onboarding Invertido · Value First (&lt; 3 min)
        </p>
        <h1 className="text-3xl font-semibold text-white">
          Revele seu primeiro diagnóstico sem formulários longos
        </h1>
        <p className="text-sm text-slate-300">
          Importe seu extrato da B3 ou do Profit agora — ou explore nossa base demonstrativa sintetizada com 45 operações reais da B3 (limpável em 1 clique).
        </p>
      </header>

      {/* Stepper acessível de 3 passos (SPEC-05) */}
      <nav aria-label="Etapas do onboarding">
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((item) => {
            const isCurrent = currentStep === item.step;
            const isDone = currentStep > item.step;
            return (
              <li
                key={item.step}
                aria-current={isCurrent ? 'step' : undefined}
                className={`rounded-xl border p-4 transition ${
                  isCurrent
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : isDone
                      ? 'border-emerald-500/40 bg-surface-900'
                      : 'border-slate-800 bg-surface-900/60'
                }`}
              >
                <p
                  className={`text-sm font-semibold ${
                    isCurrent || isDone ? 'text-profit' : 'text-slate-300'
                  }`}
                >
                  {isDone ? '✓ ' : ''}
                  {item.title}
                </p>
                <p className="mt-1 text-xs text-slate-400">{item.subtitle}</p>
              </li>
            );
          })}
        </ol>
      </nav>

      {!hasSession && (
        <section
          role="alert"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-100"
        >
          <p className="font-medium">Você precisa estar autenticado para iniciar o onboarding.</p>
          <div className="mt-3 flex gap-3">
            <Link
              href="/cadastro"
              className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300"
            >
              Criar conta
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-amber-400/50 px-4 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-500/20"
            >
              Entrar
            </Link>
          </div>
        </section>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {errorMessage}
        </div>
      )}

      {/* PASSO 1: Upload de Extrato B3/Profit OU Explorar Base Demonstrativa */}
      {currentStep === 1 && (
        <div className="grid gap-6 md:grid-cols-5">
          <section
            aria-labelledby="onboarding-upload-title"
            className="rounded-2xl border border-slate-800 bg-surface-900 p-6 md:col-span-3"
          >
            <h2
              id="onboarding-upload-title"
              className="text-lg font-semibold text-white"
            >
              Subir meu primeiro extrato (B3 ou Profit)
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Suporta CSV e XLSX com detecção automática de duplicatas.
            </p>

            <div className="mt-4 flex gap-2">
              {(
                [
                  { id: 'B3_CSV', label: 'Extrato B3' },
                  { id: 'PROFIT_CSV', label: 'Ordens Profit' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSourceHint(opt.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    sourceHint === opt.id
                      ? 'border-emerald-500 bg-emerald-500/15 text-profit'
                      : 'border-slate-700 bg-surface-950 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
                dragging
                  ? 'border-emerald-400 bg-emerald-500/10'
                  : 'border-slate-700 bg-surface-950'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="sr-only"
                onChange={(e) => {
                  setSelectedFile(e.target.files?.[0] ?? null);
                  setErrorMessage(null);
                }}
              />
              <p className="text-sm text-slate-200">
                Arraste seu arquivo aqui ou clique para selecionar
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 rounded-lg border border-slate-600 bg-surface-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                Escolher CSV/XLSX
              </button>
              {selectedFile && (
                <p className="mt-3 text-xs font-medium text-profit">
                  Selecionado: {selectedFile.name}
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={!selectedFile || busyAction !== null || !hasSession}
              onClick={handleStartUpload}
              className="mt-4 w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'upload'
                ? 'Enviando extrato...'
                : 'Continuar para Prévia'}
            </button>
          </section>

          <section
            aria-labelledby="onboarding-demo-title"
            className="flex flex-col justify-between rounded-2xl border border-amber-500/40 bg-amber-500/5 p-6 md:col-span-2"
          >
            <div className="space-y-3">
              <span className="inline-block rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-fiscal">
                Sem arquivo agora?
              </span>
              <h2
                id="onboarding-demo-title"
                className="text-lg font-semibold text-white"
              >
                Explorar Base Demonstrativa
              </h2>
              <p className="text-sm text-slate-300">
                Popule instantaneamente <strong className="text-white">45 trades sintéticos</strong> (WIN, WDO, PETR4, VALE3, ITUB4) identificados como{' '}
                <strong className="text-slate-100">dados de demonstração</strong> para ver o Dashboard em menos de 5 segundos.
              </p>
              <p className="text-xs text-slate-400">
                Você poderá apagar todos os dados demonstrativos em 1 clique assim que importar seus arquivos reais.
              </p>
            </div>

            <button
              type="button"
              disabled={busyAction !== null || !hasSession}
              onClick={handleExploreDemo}
              className="mt-6 w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'demo'
                ? 'Gerando 45 trades demo...'
                : 'Explorar Base Demonstrativa'}
            </button>
          </section>
        </div>
      )}

      {/* PASSO 2: Prévia e Conciliação Rápida */}
      {currentStep === 2 && (
        <section
          aria-labelledby="onboarding-step2-title"
          className="rounded-2xl border border-slate-800 bg-surface-900 p-6"
        >
          <h2
            id="onboarding-step2-title"
            className="text-lg font-semibold text-white"
          >
            Prévia e Conciliação Rápida
          </h2>

          {!jobDetail ||
          jobDetail.status === 'QUEUED' ||
          jobDetail.status === 'PROCESSING' ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-slate-300">
                Analisando seu extrato e verificando duplicatas por hash SHA-256...
              </p>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={jobDetail?.progress_pct ?? 20}
                className="h-2.5 w-full overflow-hidden rounded-full bg-surface-950"
              >
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${jobDetail?.progress_pct ?? 20}%` }}
                />
              </div>
            </div>
          ) : jobDetail.status === 'FAILED' ? (
            <div className="mt-4 space-y-4">
              <div
                role="alert"
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
              >
                {jobDetail.error_message_ptbr ??
                  'Não foi possível ler o arquivo enviado.'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setCurrentStep(1);
                  setJobId(null);
                  setJobDetail(null);
                }}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-surface-800"
              >
                Voltar e escolher outro arquivo
              </button>
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
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
                  <p className="text-xs text-amber-200">Conflitos detectados</p>
                  <p className="mt-1 text-2xl font-semibold text-fiscal">
                    {jobDetail.summary.conflict_count}
                  </p>
                </div>
              </div>

              {jobDetail.summary.conflict_count > 0 && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                  Os conflitos detectados foram pré-configurados como{' '}
                  <strong>Mesclar custos</strong> (mantendo os negócios e incorporando taxas/IRRF). Você também pode revisar item a item em{' '}
                  <Link href="/diario/importar" className="underline">
                    /diario/importar
                  </Link>
                  .
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setCurrentStep(1);
                    setJobId(null);
                    setJobDetail(null);
                  }}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-surface-800"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  disabled={busyAction === 'commit'}
                  onClick={handleConfirmQuickConciliation}
                  className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {busyAction === 'commit'
                    ? 'Finalizando...'
                    : 'Confirmar e Revelar Diagnóstico'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* PASSO 3: Primeiro Diagnóstico Revelado + Redirect para /dashboard */}
      {currentStep === 3 && diagnosisSummary && (
        <section
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6"
        >
          <h2 className="text-xl font-semibold text-profit">
            Primeiro diagnóstico pronto!
          </h2>
          <p className="mt-2 text-sm text-slate-200">
            {diagnosisSummary.mode === 'demo'
              ? `Sua base demonstrativa com ${diagnosisSummary.tradesCount} operações sintéticas foi carregada. Redirecionando para o Dashboard...`
              : `${diagnosisSummary.tradesCount} operação(ões) conciliadas com sucesso no seu Diário. Seu onboarding está concluído!`}
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={diagnosisSummary.redirectTo}
              className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              Abrir Dashboard (/dashboard)
            </Link>
            <Link
              href="/diario/importar"
              className="rounded-lg border border-emerald-400/50 px-4 py-2.5 text-sm font-medium text-emerald-100 hover:bg-emerald-500/20"
            >
              Importar mais arquivos
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
