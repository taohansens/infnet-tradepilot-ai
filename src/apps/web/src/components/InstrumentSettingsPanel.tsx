'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FiPlus, FiSave, FiTrash2 } from 'react-icons/fi';
import type { InstrumentConfigDto } from '@tradepilot/shared';
import {
  fetchInstrumentConfigs,
  getAccessToken,
  saveInstrumentConfigs,
} from '@/lib/apiClient';

/**
 * Painel de Configuração de Contratos/Instrumentos B3 (valor do ponto, tick,
 * custo por contrato, custo por ordem e ISS%) — portado do Taometria (`SPEC-06`).
 *
 * @spec SPEC-06
 * @rnf RNF-11
 * @rnf RNF-20
 * @rnf RNF-23
 * @rnf RNF-24
 */
export default function InstrumentSettingsPanel() {
  const [items, setItems] = useState<InstrumentConfigDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    if (!getAccessToken()) return;
    setLoading(true);
    try {
      const res = await fetchInstrumentConfigs();
      setItems(res.items);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível carregar as configurações de instrumentos.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  function updateRow(index: number, patch: Partial<InstrumentConfigDto>) {
    setItems((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    setItems((prev) => [
      ...prev,
      {
        asset_type: 'futuros',
        contract_prefix: '',
        tick_size: '0.5000',
        point_value: '1.0000',
        cost_per_contract: '0.0000',
        cost_per_order: '0.0000',
        iss_percent: '0.0000',
        is_active: true,
      },
    ]);
  }

  function removeRow(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    setErrorMsg(null);
    try {
      const res = await saveInstrumentConfigs(items);
      setItems(res.items);
      setFeedback(
        'Configurações de contratos e custos B3 salvas com precisão decimal.',
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível salvar as configurações.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="instruments-heading"
      className="ui-panel p-6"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="instruments-heading" className="text-lg font-bold">
            Contratos B3 &amp; Custos Operacionais (Profit / FIFO)
          </h2>
          <p className="mt-1 text-xs text-[var(--app-muted)]">
            Configure valor do ponto, tick, custo por contrato, custo por ordem e ISS% usados automaticamente na importação de ordens do Profit.
          </p>
        </div>
        <button
          type="button"
          onClick={addRow}
          className="ui-button-secondary text-xs"
        >
          <FiPlus className="h-3.5 w-3.5" />
          Adicionar Contrato
        </button>
      </div>

      {feedback && (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-profit"
        >
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div
          role="alert"
          className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-200"
        >
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        <div className="overflow-x-auto rounded-2xl border border-[var(--app-line)]">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[var(--app-line)] bg-[var(--app-surface-soft)] uppercase text-[var(--app-muted)]">
              <tr>
                <th className="px-3 py-2.5">Prefixo</th>
                <th className="px-3 py-2.5">Tipo</th>
                <th className="px-3 py-2.5">Tick</th>
                <th className="px-3 py-2.5">Valor/Ponto (R$)</th>
                <th className="px-3 py-2.5">Custo/Contrato (R$)</th>
                <th className="px-3 py-2.5">Custo/Ordem (R$)</th>
                <th className="px-3 py-2.5">ISS (%)</th>
                <th className="px-3 py-2.5 text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--app-line)]">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-[var(--app-muted)]">
                    Carregando configurações...
                  </td>
                </tr>
              ) : (
                items.map((row, idx) => (
                  <tr key={row.id ?? `new-${idx}`}>
                    <td className="px-2 py-2">
                      <input
                        value={row.contract_prefix}
                        onChange={(e) =>
                          updateRow(idx, {
                            contract_prefix: e.target.value.toUpperCase(),
                          })
                        }
                        placeholder="WIN"
                        className="ui-input w-24 py-1.5 font-mono text-xs"
                        required
                      />
                    </td>
                    <td className="px-2 py-2">
                      <select
                        value={row.asset_type}
                        onChange={(e) =>
                          updateRow(idx, {
                            asset_type: e.target.value as InstrumentConfigDto['asset_type'],
                          })
                        }
                        className="ui-input w-28 py-1.5 text-xs"
                      >
                        <option value="futuros">Futuros</option>
                        <option value="acoes">Ações</option>
                        <option value="opcoes">Opções</option>
                      </select>
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={row.tick_size}
                        onChange={(e) => updateRow(idx, { tick_size: e.target.value })}
                        className="ui-input w-24 py-1.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={row.point_value}
                        onChange={(e) => updateRow(idx, { point_value: e.target.value })}
                        className="ui-input w-24 py-1.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={row.cost_per_contract}
                        onChange={(e) =>
                          updateRow(idx, { cost_per_contract: e.target.value })
                        }
                        className="ui-input w-24 py-1.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={row.cost_per_order}
                        onChange={(e) =>
                          updateRow(idx, { cost_per_order: e.target.value })
                        }
                        className="ui-input w-24 py-1.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        value={row.iss_percent}
                        onChange={(e) => updateRow(idx, { iss_percent: e.target.value })}
                        className="ui-input w-20 py-1.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeRow(idx)}
                        aria-label={`Remover ${row.contract_prefix}`}
                        className="rounded-xl border border-[var(--app-line)] p-2 text-[var(--app-muted)] hover:border-red-500 hover:text-loss"
                      >
                        <FiTrash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving || items.length === 0}
            className="ui-button-primary text-xs"
          >
            <FiSave className="h-3.5 w-3.5" />
            {saving ? 'Salvando...' : 'Salvar Contratos & Custos'}
          </button>
        </div>
      </form>
    </section>
  );
}
