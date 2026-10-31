import type {
  ConciliationAction,
  DedupStatus,
  IngestionJobStatus,
  MarketType,
  OrderSide,
} from './trading.js';

/**
 * Contratos de dados do Módulo de Ingestão Assíncrona, Deduplicação e Conciliação.
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-30
 */

export type UploadSourceHint = 'B3_CSV' | 'PROFIT_CSV';

export interface CreateIngestionJobResponse {
  job_id: string;
  status: 'queued';
  file_name: string;
}

export interface MatchedTradePreview {
  id: string;
  ticker: string;
  side: string;
  qty: string;
  entry_price: string;
  fees: string;
  irrf: string;
  net_pnl: string;
  source: string;
  broker: string | null;
}

export interface StagingItemPreview {
  staging_item_id: string;
  row_number: number;
  broker: string | null;
  trade_date: string;
  executed_at: string;
  ticker: string;
  market_type: MarketType;
  side: OrderSide;
  qty: string;
  price: string;
  fees: string;
  irrf: string;
  dedup_status: DedupStatus;
  matched_trade_id: string | null;
  matched_trade: MatchedTradePreview | null;
  diff_fields: string[];
  recommended_action: ConciliationAction | null;
}

export interface IngestionJobDetailResponse {
  job_id: string;
  source_hint: UploadSourceHint;
  file_name: string;
  status: IngestionJobStatus;
  total_rows: number;
  processed_rows: number;
  progress_pct: number;
  summary: {
    new_count: number;
    exact_duplicate_count: number;
    conflict_count: number;
  };
  error_message_ptbr: string | null;
  created_at: string;
  completed_at: string | null;
  items: StagingItemPreview[];
}

export interface CommitResolutionInput {
  staging_item_id: string;
  action: ConciliationAction;
}

export interface CommitIngestionJobRequest {
  resolutions: CommitResolutionInput[];
}

export interface CommitIngestionJobResponse {
  job_id: string;
  inserted: number;
  merged: number;
  overwritten: number;
  ignored: number;
}
