import { Prisma } from '@prisma/client';
import {
  computeTradeDedupHash,
  toDecimal,
  toNumeric4String,
  type ClearDemoSeedResponse,
  type CompleteOnboardingResponse,
  type DemoSeedResponse,
  type MarketType,
  type OnboardingStatusResponse,
  type TaxSilo,
  type TradeSide,
} from '@tradepilot/shared';
import { getRequiredRlsContext } from '../db/rlsContext.js';
import { runInRlsTransaction } from '../db/prismaRls.js';

/**
 * Serviço de Onboarding Guiado Invertido ("Value First" + Base Demonstrativa Sintetizada).
 *
 * Gera 45 operações sintéticas realistas da B3 (`is_demo = true`, `source = 'DEMO'`)
 * calculadas estritamente com `Decimal` (zero ponto flutuante binário), permite limpar
 * todos os dados demonstrativos em 1 clique e marca `onboarding_completed = true`.
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-11
 * @rnf RNF-20
 * @rnf RNF-25
 */

export const DEMO_TRADES_COUNT = 45 as const;

export interface SyntheticDemoTradeInput {
  userId: string;
  ticker: string;
  marketType: MarketType;
  side: TradeSide;
  taxSilo: TaxSilo;
  source: 'DEMO';
  isDemo: true;
  entryAt: Date;
  exitAt: Date;
  qty: string;
  entryPrice: string;
  exitPrice: string;
  stopPrice: string;
  targetPrice: string;
  fees: string;
  irrf: string;
  grossPnl: string;
  netPnl: string;
  pnlPct: string;
  dedupHash: string;
  broker: string;
  setupName: string;
  followedPlan: boolean;
  preConfidence: number;
  preAnxiety: number;
  postTags: string[];
}

export interface OnboardingRepository {
  seedDemoTradesAtomic(
    userId: string,
    trades: SyntheticDemoTradeInput[],
  ): Promise<number>;
  clearDemoTradesAtomic(userId: string): Promise<number>;
  markOnboardingCompleted(userId: string): Promise<void>;
  getStatus(userId: string): Promise<OnboardingStatusResponse>;
}

interface DemoTemplate {
  ticker: string;
  marketType: MarketType;
  taxSilo: TaxSilo;
  basePrice: string;
  pointValueBrl: string;
  qty: string;
  winDelta: string;
  lossDelta: string;
  stopDistance: string;
  targetDistance: string;
  fees: string;
  broker: string;
}

const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    ticker: 'WINZ26',
    marketType: 'WIN',
    taxSilo: 'DAY_TRADE',
    basePrice: '131200.0000',
    pointValueBrl: '0.2000',
    qty: '3.0000',
    winDelta: '250.0000',
    lossDelta: '140.0000',
    stopDistance: '140.0000',
    targetDistance: '250.0000',
    fees: '2.7000',
    broker: 'XP (Demo)',
  },
  {
    ticker: 'WDOX26',
    marketType: 'WDO',
    taxSilo: 'DAY_TRADE',
    basePrice: '5450.5000',
    pointValueBrl: '10.0000',
    qty: '2.0000',
    winDelta: '12.5000',
    lossDelta: '7.5000',
    stopDistance: '7.5000',
    targetDistance: '12.5000',
    fees: '3.2000',
    broker: 'Clear (Demo)',
  },
  {
    ticker: 'PETR4',
    marketType: 'ACOES',
    taxSilo: 'SWING_TRADE',
    basePrice: '38.2000',
    pointValueBrl: '1.0000',
    qty: '200.0000',
    winDelta: '1.4500',
    lossDelta: '0.8500',
    stopDistance: '0.8500',
    targetDistance: '1.4500',
    fees: '4.5000',
    broker: 'BTG (Demo)',
  },
  {
    ticker: 'VALE3',
    marketType: 'ACOES',
    taxSilo: 'SWING_TRADE',
    basePrice: '62.1000',
    pointValueBrl: '1.0000',
    qty: '100.0000',
    winDelta: '2.1000',
    lossDelta: '1.2000',
    stopDistance: '1.2000',
    targetDistance: '2.1000',
    fees: '4.2000',
    broker: 'XP (Demo)',
  },
  {
    ticker: 'ITUB4',
    marketType: 'ACOES',
    taxSilo: 'DAY_TRADE',
    basePrice: '34.8000',
    pointValueBrl: '1.0000',
    qty: '300.0000',
    winDelta: '0.6500',
    lossDelta: '0.4000',
    stopDistance: '0.4000',
    targetDistance: '0.6500',
    fees: '3.1000',
    broker: 'Rico (Demo)',
  },
];

const DEMO_SETUPS = [
  'Rompimento VWAP',
  'Pullback M9',
  'Reversão Suporte',
  'Abertura Gap',
] as const;

/**
 * Gera exatamente 45 operações sintéticas determinísticas da B3 com precisão Decimal,
 * cobrindo ganhos, perdas, Day Trade (IRRF 1% sobre lucro) e Swing Trade (IRRF 0,005%).
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-20
 * @rnf RNF-25
 */
export function buildSyntheticDemoTrades(
  userId: string,
  referenceDate: Date = new Date(),
): SyntheticDemoTradeInput[] {
  const trades: SyntheticDemoTradeInput[] = [];
  const baseMs = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
    13,
    0,
    0,
  );

  for (let i = 0; i < DEMO_TRADES_COUNT; i += 1) {
    const template = DEMO_TEMPLATES[i % DEMO_TEMPLATES.length]!;
    const setupName = DEMO_SETUPS[i % DEMO_SETUPS.length]!;
    const side: TradeSide = i % 2 === 0 ? 'LONG' : 'SHORT';
    // ~60% de acerto determinístico (27 wins, 18 losses)
    const isWin = i % 5 !== 1 && i % 5 !== 3;
    const followedPlan = isWin ? true : i % 3 !== 0;

    // Distribui nos últimos ~30 dias úteis em horários de pregão B3 (10h–16h BRT)
    const dayOffset = Math.floor(i / 2) + 1;
    const hourOffset = (i % 6) * 35; // minutos após 10:00 BRT
    const entryAt = new Date(
      baseMs - dayOffset * 86_400_000 + hourOffset * 60_000,
    );
    const durationMinutes =
      template.taxSilo === 'DAY_TRADE' ? 18 + (i % 25) : 60 * 26;
    const exitAt = new Date(entryAt.getTime() + durationMinutes * 60_000);

    const priceJitter = toDecimal(String(i % 7)).mul(
      template.marketType === 'WIN' ? '50' : template.marketType === 'WDO' ? '2.5' : '0.15',
    );
    const entryPriceDec = toDecimal(template.basePrice).plus(priceJitter);
    const deltaDec = toDecimal(isWin ? template.winDelta : template.lossDelta);
    const signedMove =
      side === 'LONG'
        ? isWin
          ? deltaDec
          : deltaDec.negated()
        : isWin
          ? deltaDec.negated()
          : deltaDec;

    const exitPriceDec = entryPriceDec.plus(signedMove);
    const stopPriceDec =
      side === 'LONG'
        ? entryPriceDec.minus(toDecimal(template.stopDistance))
        : entryPriceDec.plus(toDecimal(template.stopDistance));
    const targetPriceDec =
      side === 'LONG'
        ? entryPriceDec.plus(toDecimal(template.targetDistance))
        : entryPriceDec.minus(toDecimal(template.targetDistance));

    const qtyDec = toDecimal(template.qty);
    const pointValueDec = toDecimal(template.pointValueBrl);
    const priceDiffForSide =
      side === 'LONG'
        ? exitPriceDec.minus(entryPriceDec)
        : entryPriceDec.minus(exitPriceDec);

    const grossPnlDec = priceDiffForSide.mul(qtyDec).mul(pointValueDec);
    const feesDec = toDecimal(template.fees);

    // IRRF realista: 1% sobre lucro positivo em Day Trade; 0,005% sobre venda em Swing Trade
    let irrfDec = toDecimal('0');
    if (template.taxSilo === 'DAY_TRADE' && grossPnlDec.gt(0)) {
      irrfDec = grossPnlDec.mul('0.01');
    } else if (template.taxSilo === 'SWING_TRADE') {
      const saleVolume = exitPriceDec.mul(qtyDec);
      irrfDec = saleVolume.mul('0.00005');
    }

    const netPnlDec = grossPnlDec.minus(feesDec).minus(irrfDec);
    const notionalDec = entryPriceDec.mul(qtyDec).mul(pointValueDec);
    const pnlPctDec = notionalDec.gt(0)
      ? netPnlDec.div(notionalDec).mul(100)
      : toDecimal('0');

    const dedupHash = computeTradeDedupHash({
      userId,
      ticker: template.ticker,
      executedAt: entryAt,
      side: side === 'LONG' ? 'BUY' : 'SELL',
      qty: qtyDec,
      price: entryPriceDec,
    });

    trades.push({
      userId,
      ticker: template.ticker,
      marketType: template.marketType,
      side,
      taxSilo: template.taxSilo,
      source: 'DEMO',
      isDemo: true,
      entryAt,
      exitAt,
      qty: toNumeric4String(qtyDec),
      entryPrice: toNumeric4String(entryPriceDec),
      exitPrice: toNumeric4String(exitPriceDec),
      stopPrice: toNumeric4String(stopPriceDec),
      targetPrice: toNumeric4String(targetPriceDec),
      fees: toNumeric4String(feesDec),
      irrf: toNumeric4String(irrfDec),
      grossPnl: toNumeric4String(grossPnlDec),
      netPnl: toNumeric4String(netPnlDec),
      pnlPct: toNumeric4String(pnlPctDec),
      dedupHash,
      broker: template.broker,
      setupName,
      followedPlan,
      preConfidence: isWin ? 4 : 3,
      preAnxiety: isWin ? 2 : 4,
      postTags: isWin ? ['disciplined'] : followedPlan ? ['disciplined'] : ['fomo'],
    });
  }

  return trades;
}

/**
 * Implementação Prisma + PostgreSQL sob Row-Level Security (`RNF-11`).
 *
 * @spec SPEC-05
 * @rnf RNF-11
 */
export class PrismaOnboardingRepository implements OnboardingRepository {
  public async seedDemoTradesAtomic(
    userId: string,
    trades: SyntheticDemoTradeInput[],
  ): Promise<number> {
    return runInRlsTransaction(async (tx) => {
      // Idempotência: limpa eventual base demo anterior antes de popular novamente
      await tx.trade.deleteMany({
        where: { userId, isDemo: true },
      });

      const created = await tx.trade.createMany({
        data: trades.map((t) => ({
          userId: t.userId,
          ticker: t.ticker,
          marketType: t.marketType,
          side: t.side,
          taxSilo: t.taxSilo,
          source: t.source,
          isDemo: true,
          entryAt: t.entryAt,
          exitAt: t.exitAt,
          qty: new Prisma.Decimal(t.qty),
          entryPrice: new Prisma.Decimal(t.entryPrice),
          exitPrice: new Prisma.Decimal(t.exitPrice),
          stopPrice: new Prisma.Decimal(t.stopPrice),
          targetPrice: new Prisma.Decimal(t.targetPrice),
          fees: new Prisma.Decimal(t.fees),
          irrf: new Prisma.Decimal(t.irrf),
          grossPnl: new Prisma.Decimal(t.grossPnl),
          netPnl: new Prisma.Decimal(t.netPnl),
          pnlPct: new Prisma.Decimal(t.pnlPct),
          dedupHash: t.dedupHash,
          broker: t.broker,
          setupName: t.setupName,
          followedPlan: t.followedPlan,
          preConfidence: t.preConfidence,
          preAnxiety: t.preAnxiety,
          postTags: t.postTags,
        })),
      });

      await tx.user.update({
        where: { id: userId },
        data: { onboardingCompleted: true },
      });

      return created.count;
    });
  }

  public async clearDemoTradesAtomic(userId: string): Promise<number> {
    return runInRlsTransaction(async (tx) => {
      const result = await tx.trade.deleteMany({
        where: { userId, isDemo: true },
      });
      return result.count;
    });
  }

  public async markOnboardingCompleted(userId: string): Promise<void> {
    await runInRlsTransaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { onboardingCompleted: true },
      });
    });
  }

  public async getStatus(userId: string): Promise<OnboardingStatusResponse> {
    return runInRlsTransaction(async (tx) => {
      const [user, demoCount, realCount] = await Promise.all([
        tx.user.findUnique({
          where: { id: userId },
          select: { onboardingCompleted: true },
        }),
        tx.trade.count({ where: { userId, isDemo: true } }),
        tx.trade.count({ where: { userId, isDemo: false } }),
      ]);

      return {
        onboarding_completed: user?.onboardingCompleted ?? false,
        has_demo_trades: demoCount > 0,
        demo_trades_count: demoCount,
        real_trades_count: realCount,
      };
    });
  }
}

export class OnboardingService {
  private readonly repository: OnboardingRepository;

  constructor(repository?: OnboardingRepository) {
    this.repository = repository ?? new PrismaOnboardingRepository();
  }

  /**
   * Popula 45 trades sintéticos (`is_demo = true`) para o usuário autenticado
   * e libera o primeiro diagnóstico em `< 5s` (`SPEC-05`, `ADR-04`).
   *
   * @spec SPEC-05
   * @rf RF-T-3
   * @rnf RNF-11
   * @rnf RNF-25
   */
  public async seedDemoData(): Promise<DemoSeedResponse> {
    const ctx = getRequiredRlsContext();
    const syntheticTrades = buildSyntheticDemoTrades(ctx.userId);
    const seededCount = await this.repository.seedDemoTradesAtomic(
      ctx.userId,
      syntheticTrades,
    );

    return {
      seeded_trades: seededCount,
      is_demo: true,
      redirect_to: '/dashboard',
    };
  }

  /**
   * Remove em 1 clique todos os trades marcados com `is_demo = true` da conta.
   *
   * @spec SPEC-05
   * @rf RF-T-3
   * @rnf RNF-11
   */
  public async clearDemoData(): Promise<ClearDemoSeedResponse> {
    const ctx = getRequiredRlsContext();
    const removed = await this.repository.clearDemoTradesAtomic(ctx.userId);

    return {
      removed_demo_trades: removed,
      message:
        removed > 0
          ? `${removed} operação(ões) da base demonstrativa foram removidas com sucesso.`
          : 'Não há operações demonstrativas pendentes na sua conta.',
    };
  }

  /**
   * Conclui o onboarding após importação real de arquivo (`SPEC-05` Critério 2).
   *
   * @spec SPEC-05
   * @rf RF-T-3
   * @rnf RNF-25
   */
  public async completeOnboarding(): Promise<CompleteOnboardingResponse> {
    const ctx = getRequiredRlsContext();
    await this.repository.markOnboardingCompleted(ctx.userId);
    return {
      onboarding_completed: true,
      redirect_to: '/dashboard',
    };
  }

  /**
   * Consulta o status atual de onboarding e presença de base demonstrativa.
   *
   * @spec SPEC-05
   * @rf RF-T-3
   */
  public async getStatus(): Promise<OnboardingStatusResponse> {
    const ctx = getRequiredRlsContext();
    return this.repository.getStatus(ctx.userId);
  }
}

export const onboardingService = new OnboardingService();
