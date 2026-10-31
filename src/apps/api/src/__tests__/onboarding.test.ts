import { describe, expect, it } from 'vitest';
import { toDecimal } from '@tradepilot/shared';
import {
  buildSyntheticDemoTrades,
  DEMO_TRADES_COUNT,
  OnboardingService,
  type OnboardingRepository,
  type SyntheticDemoTradeInput,
} from '../services/onboardingService.js';
import { runWithRlsContext } from '../db/rlsContext.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Testes automatizados do Onboarding Guiado Invertido (`SPEC-05`, `ADR-04`).
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-11
 * @rnf RNF-20
 * @rnf RNF-25
 */
describe('OnboardingService (SPEC-05 — Demo Seed 45 trades + Limpeza 1 clique)', () => {
  it('gera exatamente 45 trades sintéticos determinísticos com is_demo=true e matemática Decimal exata', () => {
    const trades = buildSyntheticDemoTrades(
      USER_ID,
      new Date('2026-11-22T15:00:00Z'),
    );

    expect(trades).toHaveLength(DEMO_TRADES_COUNT);
    expect(trades.every((t) => t.isDemo === true && t.source === 'DEMO')).toBe(
      true,
    );
    expect(trades.every((t) => t.userId === USER_ID)).toBe(true);
    expect(trades.every((t) => t.dedupHash.length === 64)).toBe(true);

    // Verifica consistência aritmética exata: netPnl === grossPnl - fees - irrf
    for (const t of trades) {
      const expectedNet = toDecimal(t.grossPnl)
        .minus(toDecimal(t.fees))
        .minus(toDecimal(t.irrf))
        .toDecimalPlaces(4)
        .toFixed(4);
      expect(t.netPnl).toBe(expectedNet);
    }

    // Garante cobertura dos dois silos tributários (DAY_TRADE e SWING_TRADE)
    expect(trades.some((t) => t.taxSilo === 'DAY_TRADE')).toBe(true);
    expect(trades.some((t) => t.taxSilo === 'SWING_TRADE')).toBe(true);
  });

  it('popula 45 trades demo, retorna redirect_to=/dashboard e limpa em 1 clique', async () => {
    let demoStore: SyntheticDemoTradeInput[] = [];
    let onboardingCompleted = false;

    const repo: OnboardingRepository = {
      async seedDemoTradesAtomic(_userId, trades) {
        demoStore = [...trades];
        onboardingCompleted = true;
        return demoStore.length;
      },
      async clearDemoTradesAtomic() {
        const count = demoStore.length;
        demoStore = [];
        return count;
      },
      async markOnboardingCompleted() {
        onboardingCompleted = true;
      },
      async getStatus() {
        return {
          onboarding_completed: onboardingCompleted,
          has_demo_trades: demoStore.length > 0,
          demo_trades_count: demoStore.length,
          real_trades_count: 0,
        };
      },
    };

    const service = new OnboardingService(repo);

    const seeded = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-demo-1' },
      () => service.seedDemoData(),
    );

    expect(seeded).toEqual({
      seeded_trades: 45,
      is_demo: true,
      redirect_to: '/dashboard',
    });

    const statusAfterSeed = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-demo-2' },
      () => service.getStatus(),
    );
    expect(statusAfterSeed).toEqual({
      onboarding_completed: true,
      has_demo_trades: true,
      demo_trades_count: 45,
      real_trades_count: 0,
    });

    // Limpeza em 1 clique
    const cleared = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-demo-3' },
      () => service.clearDemoData(),
    );
    expect(cleared.removed_demo_trades).toBe(45);

    const statusAfterClear = await runWithRlsContext(
      { userId: USER_ID, requestId: 'req-demo-4' },
      () => service.getStatus(),
    );
    expect(statusAfterClear.has_demo_trades).toBe(false);
    expect(statusAfterClear.demo_trades_count).toBe(0);
  });
});
