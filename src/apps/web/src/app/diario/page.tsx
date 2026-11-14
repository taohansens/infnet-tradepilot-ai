'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FiDownloadCloud, FiEdit3, FiPlus, FiX } from 'react-icons/fi';
import {
  formatBrl,
  type MarketType,
  type TradeDto,
  type TradeSide,
} from '@tradepilot/shared';
import AppShell from '@/components/AppShell';
import {
  createManualTrade,
  fetchTrades,
  getAccessToken,
  updateTradeContext,
} from '@/lib/apiClient';

/**
 * Diário & Livro de Trades no visual do Taometria (`SPEC-10`, `SPEC-12`, `SPEC-13`):
 * - Tabela de operações com filtros rápidos
 * - Modal "Novo Trade Manual" com cálculo determinístico no backend
 * - Gaveta lateral de Contextualização (Setup, Seguiu o Plano, Notas) e Estado Emocional
 *
 * @spec SPEC-10
 * @spec SPEC-12
 * @spec SPEC-13
 * @rf RF-M1-1
 * @rf RF-M1-3
 * @rf RF-M1-4
 * @rnf RNF-23
 * @rnf RNF-24
 */

const POST_EMOTION_TAGS = [
  { id: 'disciplined', label: 'Disciplinado' },
  { id: 'fomo', label: 'FOMO' },
  { id: 'revenge', label: 'Revanche' },
  { id: 'frustrated', label: 'Frustrado' },
  { id: 'euphoric', label: 'Eufórico' },
] as const;

export default function DiarioPage() {
  const [trades, setTrades] = useState<TradeDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modal Novo Trade Manual (SPEC-10)
  const [createOpen, setCreateOpen] = useState(false);
  const [ticker, setTicker] = useState('WINZ26');
  const [marketType, setMarketType] = useState<MarketType>('WIN');
  const [side, setSide] = useState<TradeSide>('LONG');
  const [qty, setQty] = useState('2');
  const [entryPrice, setEntryPrice] = useState('131200');
  const [exitPrice, setExitPrice] = useState('131450');
  const [fees, setFees] = useState('1.80');
  const [setupName, setSetupName] = useState('Rompimento VWAP');
  const [savingNew, setSavingNew] = useState(false);

  // Gaveta lateral de Contexto & Psicologia (SPEC-12, SPEC-13)
  const [selectedTrade, setSelectedTrade] = useState<TradeDto | null>(null);
  const [ctxSetup, setCtxSetup] = useState('');
  const [ctxFollowedPlan, setCtxFollowedPlan] = useState(true);
  const [ctxNotes, setCtxNotes] = useState('');
  const [ctxConfidence, setCtxConfidence] = useState(4);
  const [ctxAnxiety, setCtxAnxiety] = useState(2);
  const [ctxTags, setCtxTags] = useState<string[]>([]);
  const [savingCtx, setSavingCtx] = useState(false);

  const loadTrades = useCallback(async () => {
    if (!getAccessToken()) return;
    setLoading(true);
    try {
      const res = await fetchTrades();
      setTrades(res.items);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao carregar trades.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrades();
  }, [loadTrades]);

  function openContextDrawer(trade: TradeDto) {
    setSelectedTrade(trade);
    setCtxSetup(trade.setup_name ?? '');
    setCtxFollowedPlan(trade.followed_plan ?? true);
    setCtxNotes(trade.notes ?? '');
    setCtxConfidence(trade.pre_confidence ?? 3);
    setCtxAnxiety(trade.pre_anxiety ?? 2);
    setCtxTags(trade.post_tags ?? []);
  }

  async function handleCreateTrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingNew(true);
    setErrorMsg(null);
    try {
      const now = new Date();
      const entryAt = new Date(now.getTime() - 15 * 60_000).toISOString();
      const exitAt = now.toISOString();
      await createManualTrade({
        ticker,
        market_type: marketType,
        side,
        qty,
        entry_price: entryPrice,
        exit_price: exitPrice,
        fees,
        entry_at: entryAt,
        exit_at: exitAt,
        setup_name: setupName,
        followed_plan: true,
      });
      setCreateOpen(false);
      setFeedback('Operação manual registrada com cálculo determinístico e auditada.');
      await loadTrades();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao cadastrar operação.');
    } finally {
      setSavingNew(false);
    }
  }

  async function handleSaveContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTrade) return;
    setSavingCtx(true);
    setErrorMsg(null);
    try {
      await updateTradeContext(selectedTrade.id, {
        setup_name: ctxSetup,
        followed_plan: ctxFollowedPlan,
        notes: ctxNotes,
        pre_confidence: ctxConfidence,
        pre_anxiety: ctxAnxiety,
        post_tags: ctxTags,
      });
      setSelectedTrade(null);
      setFeedback('Contexto operacional e registro emocional salvos.');
      await loadTrades();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao atualizar operação.');
    } finally {
      setSavingCtx(false);
    }
  }

  const filtered = trades.filter(
    (t) =>
      t.ticker.toLowerCase().includes(search.toLowerCase()) ||
      (t.setup_name ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <AppShell subtitle="Diário & Livro de Trades">
      <div className="space-y-5">
        <section className="ui-panel">
          <div className="ui-hero-band flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--app-muted-2)]">
                Registro Operacional &amp; Disciplina
              </p>
              <h1 className="mt-0.5 text-2xl font-black">Livro de Trades</h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filtrar por ativo ou setup..."
                aria-label="Filtrar operações por ativo ou setup"
                className="ui-input w-56 py-2 text-xs"
              />
              <Link href="/diario/importar" className="ui-button-secondary text-xs">
                <FiDownloadCloud className="h-4 w-4" />
                Importar B3/Profit
              </Link>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="ui-button-primary text-xs"
              >
                <FiPlus className="h-4 w-4" />
                Novo Trade Manual
              </button>
            </div>
          </div>

          {feedback && (
            <div className="mx-5 mt-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-profit">
              {feedback}
            </div>
          )}
          {errorMsg && (
            <div
              role="alert"
              className="mx-5 mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-200"
            >
              {errorMsg}
            </div>
          )}

          <div className="overflow-x-auto p-5">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--app-line)] uppercase text-[var(--app-muted)]">
                <tr>
                  <th className="px-3 py-3">Saída</th>
                  <th className="px-3 py-3">Ativo</th>
                  <th className="px-3 py-3">Silo</th>
                  <th className="px-3 py-3">Lado</th>
                  <th className="px-3 py-3">Qtd</th>
                  <th className="px-3 py-3">Entrada / Saída</th>
                  <th className="px-3 py-3">Setup</th>
                  <th className="px-3 py-3">Plano</th>
                  <th className="px-3 py-3">Resultado Líq.</th>
                  <th className="px-3 py-3 text-right">Revisar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--app-line)]">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-[var(--app-muted)]">
                      Carregando operações...
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-[var(--app-muted)]">
                      Nenhuma operação encontrada. Importe um arquivo B3/Profit ou cadastre um trade manual.
                    </td>
                  </tr>
                ) : (
                  filtered.map((t) => {
                    const positive = Number(t.net_pnl) >= 0;
                    return (
                      <tr key={t.id} className="hover:bg-[var(--app-surface-soft)]">
                        <td className="whitespace-nowrap px-3 py-3 font-mono text-[var(--app-muted)]">
                          {new Date(t.exit_at).toLocaleString('pt-BR')}
                        </td>
                        <td className="px-3 py-3 font-bold">
                          {t.ticker}
                          {t.is_demo && (
                            <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-fiscal">
                              Demo
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-[var(--app-muted)]">
                          {t.tax_silo === 'DAY_TRADE' ? 'Day Trade' : 'Swing'}
                        </td>
                        <td className="px-3 py-3">{t.side}</td>
                        <td className="px-3 py-3 font-mono">{t.qty}</td>
                        <td className="px-3 py-3 font-mono text-[var(--app-muted)]">
                          {t.entry_price} → {t.exit_price}
                        </td>
                        <td className="px-3 py-3">{t.setup_name ?? '—'}</td>
                        <td className="px-3 py-3">
                          {t.followed_plan === null ? (
                            '—'
                          ) : t.followed_plan ? (
                            <span className="text-profit">Seguiu</span>
                          ) : (
                            <span className="text-loss">Desvio</span>
                          )}
                        </td>
                        <td
                          className={`px-3 py-3 font-mono font-bold ${
                            positive ? 'text-profit' : 'text-loss'
                          }`}
                        >
                          {formatBrl(t.net_pnl)}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openContextDrawer(t)}
                            className="inline-flex items-center gap-1 rounded-xl border border-[var(--app-line)] px-2.5 py-1 text-xs font-semibold hover:border-emerald-400"
                          >
                            <FiEdit3 className="h-3.5 w-3.5" />
                            Diário
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Modal Novo Trade Manual (SPEC-10) */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-trade-title"
        >
          <div className="w-full max-w-lg rounded-3xl border border-[var(--app-line)] bg-[var(--app-surface-strong)] p-6 shadow-2xl">
            <header className="mb-4 flex items-center justify-between">
              <h2 id="new-trade-title" className="text-lg font-bold">
                Novo Trade Manual
              </h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                aria-label="Fechar"
                className="rounded-full border border-[var(--app-line)] p-2"
              >
                <FiX className="h-4 w-4" />
              </button>
            </header>

            <form onSubmit={handleCreateTrade} className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Ativo</label>
                  <input value={ticker} onChange={(e) => setTicker(e.target.value)} className="ui-input" required />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Mercado</label>
                  <select
                    value={marketType}
                    onChange={(e) => setMarketType(e.target.value as MarketType)}
                    className="ui-input"
                  >
                    <option value="WIN">WIN</option>
                    <option value="WDO">WDO</option>
                    <option value="ACOES">ACOES</option>
                    <option value="OPCOES">OPCOES</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Lado</label>
                  <select
                    value={side}
                    onChange={(e) => setSide(e.target.value as TradeSide)}
                    className="ui-input"
                  >
                    <option value="LONG">LONG</option>
                    <option value="SHORT">SHORT</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Qtd</label>
                  <input value={qty} onChange={(e) => setQty(e.target.value)} className="ui-input font-mono" required />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Entrada</label>
                  <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} className="ui-input font-mono" required />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Saída</label>
                  <input value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} className="ui-input font-mono" required />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Taxas (R$)</label>
                  <input value={fees} onChange={(e) => setFees(e.target.value)} className="ui-input font-mono" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">Setup</label>
                  <input value={setupName} onChange={(e) => setSetupName(e.target.value)} className="ui-input" />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button type="button" onClick={() => setCreateOpen(false)} className="ui-button-secondary">
                  Cancelar
                </button>
                <button type="submit" disabled={savingNew} className="ui-button-primary">
                  {savingNew ? 'Salvando...' : 'Salvar Operação'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Gaveta Lateral de Contexto Operacional & Psicologia (SPEC-12, SPEC-13) */}
      {selectedTrade && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ctx-drawer-title"
        >
          <div className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--app-line)] bg-[var(--app-surface-strong)] p-6 shadow-2xl">
            <header className="mb-5 flex items-center justify-between border-b border-[var(--app-line)] pb-4">
              <div>
                <p className="text-xs font-semibold uppercase text-profit">
                  Diário Operacional &amp; Psicologia
                </p>
                <h2 id="ctx-drawer-title" className="text-lg font-bold">
                  {selectedTrade.ticker} · {formatBrl(selectedTrade.net_pnl)}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTrade(null)}
                aria-label="Fechar gaveta"
                className="rounded-full border border-[var(--app-line)] p-2"
              >
                <FiX className="h-4 w-4" />
              </button>
            </header>

            <form onSubmit={handleSaveContext} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                  Setup Utilizado
                </label>
                <input
                  value={ctxSetup}
                  onChange={(e) => setCtxSetup(e.target.value)}
                  placeholder="Ex.: Rompimento VWAP, Pullback M9"
                  className="ui-input"
                />
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ctxFollowedPlan}
                  onChange={(e) => setCtxFollowedPlan(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>Segui rigorosamente o meu plano operacional</span>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">
                    Confiança Pré (1–5): {ctxConfidence}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={ctxConfidence}
                    onChange={(e) => setCtxConfidence(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--app-muted)]">
                    Ansiedade Pré (1–5): {ctxAnxiety}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={ctxAnxiety}
                    onChange={(e) => setCtxAnxiety(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-[var(--app-muted)]">
                  Tags Pós-Operação
                </p>
                <div className="flex flex-wrap gap-2">
                  {POST_EMOTION_TAGS.map((tag) => {
                    const active = ctxTags.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() =>
                          setCtxTags((prev) =>
                            active
                              ? prev.filter((item) => item !== tag.id)
                              : [...prev, tag.id],
                          )
                        }
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                          active
                            ? 'border-emerald-500 bg-emerald-500/15 text-profit'
                            : 'border-[var(--app-line)] text-[var(--app-muted)]'
                        }`}
                      >
                        {tag.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--app-muted)]">
                  Notas da Execução
                </label>
                <textarea
                  rows={4}
                  value={ctxNotes}
                  onChange={(e) => setCtxNotes(e.target.value)}
                  className="ui-input"
                  placeholder="Motivo de entrada, condução do trade e lições aprendidas..."
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedTrade(null)}
                  className="ui-button-secondary"
                >
                  Cancelar
                </button>
                <button type="submit" disabled={savingCtx} className="ui-button-primary">
                  {savingCtx ? 'Salvando...' : 'Salvar Diário'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
