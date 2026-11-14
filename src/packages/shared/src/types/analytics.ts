import type { MarketType, TaxSilo, TradeSide } from './trading.js';

/**
 * Contratos de dados de Diário de Trade, Analytics Determinístico e Raio-X da Fórmula.
 * Todos os valores monetários trafegam como strings decimais exatas (`NUMERIC(18,4)`).
 *
 * @spec SPEC-10
 * @spec SPEC-12
 * @spec SPEC-13
 * @spec SPEC-14
 * @spec SPEC-15
 * @spec SPEC-16
 * @spec SPEC-17
 * @spec SPEC-20
 * @rf RF-M1-1
 * @rf RF-M2-1
 * @rf RF-M2-2
 * @rf RF-M2-3
 * @rf RF-M2-4
 * @rnf RNF-19
 * @rnf RNF-20
 * @rnf RNF-29
 */

export interface TradeDto {
  id: string;
  ticker: string;
  market_type: MarketType;
  side: TradeSide;
  tax_silo: TaxSilo;
  source: string;
  is_demo: boolean;
  entry_at: string;
  exit_at: string;
  qty: string;
  entry_price: string;
  exit_price: string;
  stop_price: string | null;
  target_price: string | null;
  fees: string;
  irrf: string;
  gross_pnl: string;
  net_pnl: string;
  pnl_pct: string | null;
  broker: string | null;
  setup_name: string | null;
  followed_plan: boolean | null;
  entry_reason: string | null;
  exit_reason: string | null;
  notes: string | null;
  pre_confidence: number | null;
  pre_anxiety: number | null;
  post_tags: string[];
  emotional_note: string | null;
}

export interface CreateManualTradeRequest {
  ticker: string;
  market_type: MarketType;
  side: TradeSide;
  entry_at: string;
  exit_at: string;
  entry_price: string;
  exit_price: string;
  qty: string;
  stop_price?: string;
  target_price?: string;
  fees?: string;
  irrf?: string;
  broker?: string;
  setup_name?: string;
  followed_plan?: boolean;
  notes?: string;
}

export interface FormulaXRayDto {
  metric: string;
  label: string;
  formula: string;
  inputs: Record<string, string>;
  substitution: string;
  result: string;
}

export interface AnalyticsSummaryResponse {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: string;
  payoff: string | null;
  profit_factor: string | null;
  profit_factor_infinite: boolean;
  expectancy_brl: string;
  total_pnl_brl: string;
  gross_profit_brl: string;
  gross_loss_brl: string;
  avg_win_brl: string;
  avg_loss_brl: string;
  max_win_streak: number;
  max_loss_streak: number;
  max_drawdown_brl: string;
  plan_adherence_pct: string;
  xray: Record<string, FormulaXRayDto>;
}

export interface EquityPointDto {
  timestamp: string;
  date: string;
  trade_pnl_brl: string;
  cumulative_pnl_brl: string;
  drawdown_brl: string;
}

export interface DailyCalendarBucketDto {
  date: string;
  trades_count: number;
  wins: number;
  losses: number;
  net_pnl_brl: string;
}

export interface EquityCurveResponse {
  points: EquityPointDto[];
  daily_calendar: DailyCalendarBucketDto[];
}

export interface BreakdownBucketDto {
  key: string;
  trades: number;
  win_rate: string;
  net_pnl_brl: string;
  profit_factor: string | null;
}

export interface DeterministicInsightDto {
  code: string;
  severity: 'info' | 'warning' | 'positive';
  message: string;
  sample_size: number;
}

export interface AnalyticsBreakdownResponse {
  dimension: 'hour_bucket' | 'day_of_week' | 'ticker' | 'setup_id';
  buckets: BreakdownBucketDto[];
  insights: DeterministicInsightDto[];
}
