-- ============================================================================
-- Migration: 001_init_rls_audit.sql
-- Projeto: TradePilot AI
-- Descrição: Criação das tabelas base (users, audit_logs, trades,
--            ingestion_jobs, staging_items), isolamento multi-tenant via
--            Row-Level Security (RLS) obrigatório, imutabilidade append-only
--            em audit_logs e precisão monetária exata com NUMERIC(18,4).
--
-- Rastreabilidade:
--   @spec SPEC-01 (Autenticação, usuários, 2FA)
--   @spec SPEC-03 (LGPD - exclusão de conta preservando rastro mínimo em audit_logs)
--   @spec SPEC-04 (Trilha de Auditoria Transacional Imutável - Append-Only)
--   @spec SPEC-06, SPEC-07, SPEC-08, SPEC-09 (Ingestão, deduplicação e conciliação)
--   @spec SPEC-10, SPEC-12, SPEC-13 (Diário de Trade, contexto e psicologia)
--   @spec SPEC-23 (Segregação tributária Day Trade vs Swing Trade)
--   @rf   RF-T-1, RF-T-4, RF-M1-1, RF-M1-5, RF-M1-6, RF-M1-7, RF-M5-1
--   @rnf  RNF-9, RNF-11, RNF-12, RNF-13, RNF-15, RNF-20, RNF-30
-- ============================================================================

BEGIN;

-- Extensão criptográfica para geração de UUIDv4
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Role de aplicação sem privilégio de superuser e com NOBYPASSRLS (RNF-11)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_app') THEN
    CREATE ROLE tradepilot_app
      LOGIN
      PASSWORD 'tradepilot_app_dev_password'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOBYPASSRLS;
  ELSE
    ALTER ROLE tradepilot_app NOBYPASSRLS NOSUPERUSER;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tradepilot_app;

-- ----------------------------------------------------------------------------
-- 2. Função auxiliar de leitura segura do tenant atual na transação (RNF-11)
--    Retorna NULL se app.current_user_id não estiver configurado, fazendo com
--    que todas as políticas RLS neguem acesso por padrão (fail-closed).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- ----------------------------------------------------------------------------
-- 3. Tabela: users (@spec SPEC-01, @rf RF-T-1, @rnf RNF-11, RNF-12, RNF-13)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL,
  email                 TEXT        NOT NULL UNIQUE,
  password_hash         TEXT        NOT NULL,
  totp_secret_encrypted TEXT,
  totp_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  lgpd_consent_at       TIMESTAMPTZ NOT NULL,
  onboarding_completed  BOOLEAN     NOT NULL DEFAULT FALSE,
  plan_code             TEXT        NOT NULL DEFAULT 'trial',
  plan_status           TEXT        NOT NULL DEFAULT 'trial'
    CHECK (plan_status IN ('trial', 'active', 'past_due', 'canceled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self_isolation ON users;
CREATE POLICY users_self_isolation ON users
  FOR ALL
  TO tradepilot_app
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());

-- Função controlada (SECURITY DEFINER) exclusivamente para autenticação inicial
-- antes que app.current_user_id exista na sessão (@spec SPEC-01).
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email TEXT)
RETURNS TABLE (
  id                   UUID,
  email                TEXT,
  password_hash        TEXT,
  totp_enabled         BOOLEAN,
  plan_status          TEXT,
  onboarding_completed BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.email, u.password_hash, u.totp_enabled, u.plan_status, u.onboarding_completed
  FROM users u
  WHERE LOWER(u.email) = LOWER(TRIM(p_email))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION auth_find_user_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(TEXT) TO tradepilot_app;

-- ----------------------------------------------------------------------------
-- 4. Tabela: audit_logs (@spec SPEC-04, SPEC-03, @rnf RNF-15, RNF-30, RNF-11)
--    Estritamente APPEND-ONLY:
--      - Sem ON DELETE CASCADE para preservar rastro legal na exclusão LGPD
--      - Role tradepilot_app possui apenas SELECT e INSERT (sem UPDATE/DELETE)
--      - Trigger defensivo bloqueia UPDATE e DELETE até para owners
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID,
  actor_id        UUID        NOT NULL,
  action          TEXT        NOT NULL CHECK (
    action IN (
      'TRADE_MANUAL_CREATE',
      'TRADE_EDIT',
      'TRADE_DELETE',
      'CONCILIATION_MERGE',
      'FISCAL_PRIOR_LOSS_SET',
      'DATA_EXPORT',
      'ACCOUNT_DELETE'
    )
  ),
  entity_type     TEXT        NOT NULL,
  entity_id       UUID        NOT NULL,
  before_snapshot JSONB,
  after_snapshot  JSONB,
  request_id      TEXT,
  ip_hash         TEXT,
  created_at_utc  TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON audit_logs (user_id, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON audit_logs (user_id, entity_type, entity_id);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select_own ON audit_logs;
CREATE POLICY audit_logs_select_own ON audit_logs
  FOR SELECT
  TO tradepilot_app
  USING (user_id = app_current_user_id());

DROP POLICY IF EXISTS audit_logs_insert_own ON audit_logs;
CREATE POLICY audit_logs_insert_own ON audit_logs
  FOR INSERT
  TO tradepilot_app
  WITH CHECK (
    user_id = app_current_user_id()
    AND actor_id = app_current_user_id()
  );

-- Defesa em profundidade: impede UPDATE/DELETE mesmo por roles privilegiadas
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Operação % proibida: audit_logs é estritamente append-only (SPEC-04, RNF-30).', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

-- ----------------------------------------------------------------------------
-- 5. Tabela: trades (@spec SPEC-08, SPEC-10, SPEC-12, SPEC-13, SPEC-23)
--    Todos os valores monetários e preços utilizam NUMERIC(18,4) (zero float)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker         TEXT           NOT NULL,
  market_type    TEXT           NOT NULL CHECK (market_type IN ('WIN', 'WDO', 'ACOES', 'OPCOES')),
  side           TEXT           NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  tax_silo       TEXT           NOT NULL CHECK (tax_silo IN ('DAY_TRADE', 'SWING_TRADE')),
  source         TEXT           NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('B3_CSV', 'PROFIT_CSV', 'SINACOR_PDF', 'MANUAL', 'DEMO')),
  is_demo        BOOLEAN        NOT NULL DEFAULT FALSE,
  entry_at       TIMESTAMPTZ    NOT NULL,
  exit_at        TIMESTAMPTZ    NOT NULL,
  qty            NUMERIC(18, 4) NOT NULL CHECK (qty > 0),
  entry_price    NUMERIC(18, 4) NOT NULL CHECK (entry_price >= 0),
  exit_price     NUMERIC(18, 4) NOT NULL CHECK (exit_price >= 0),
  stop_price     NUMERIC(18, 4),
  target_price   NUMERIC(18, 4),
  fees           NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  irrf           NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  gross_pnl      NUMERIC(18, 4) NOT NULL,
  net_pnl        NUMERIC(18, 4) NOT NULL,
  pnl_pct        NUMERIC(18, 4),
  dedup_hash     CHAR(64),
  broker         TEXT,
  setup_name     TEXT,
  followed_plan  BOOLEAN,
  entry_reason   TEXT,
  exit_reason    TEXT,
  notes          TEXT,
  pre_confidence SMALLINT       CHECK (pre_confidence BETWEEN 1 AND 5),
  pre_anxiety    SMALLINT       CHECK (pre_anxiety BETWEEN 1 AND 5),
  post_tags      TEXT[]         NOT NULL DEFAULT '{}',
  emotional_note TEXT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_trades_chronology CHECK (exit_at >= entry_at)
);

CREATE INDEX IF NOT EXISTS idx_trades_user_exit_at
  ON trades (user_id, exit_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_user_tax_silo
  ON trades (user_id, tax_silo, exit_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_user_dedup_hash
  ON trades (user_id, dedup_hash)
  WHERE dedup_hash IS NOT NULL;

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trades_tenant_isolation ON trades;
CREATE POLICY trades_tenant_isolation ON trades
  FOR ALL
  TO tradepilot_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- ----------------------------------------------------------------------------
-- 6. Tabela: ingestion_jobs (@spec SPEC-06, SPEC-07, SPEC-09, @rf RF-M1-5)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hint        TEXT        NOT NULL CHECK (source_hint IN ('B3_CSV', 'PROFIT_CSV', 'SINACOR_PDF')),
  file_name          TEXT        NOT NULL,
  file_sha256        CHAR(64)    NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PROCESSING', 'AWAITING_REVIEW', 'COMMITTED', 'FAILED')),
  total_rows         INTEGER     NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  processed_rows     INTEGER     NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
  conflict_count     INTEGER     NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  error_message_ptbr TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_user_created
  ON ingestion_jobs (user_id, created_at DESC);

ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingestion_jobs_tenant_isolation ON ingestion_jobs;
CREATE POLICY ingestion_jobs_tenant_isolation ON ingestion_jobs
  FOR ALL
  TO tradepilot_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- ----------------------------------------------------------------------------
-- 7. Tabela: staging_items (@spec SPEC-06, SPEC-07, SPEC-08, SPEC-09)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staging_items (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            UUID           NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  row_number        INTEGER        NOT NULL CHECK (row_number > 0),
  broker            TEXT,
  trade_date        DATE           NOT NULL,
  executed_at       TIMESTAMPTZ    NOT NULL,
  ticker            TEXT           NOT NULL,
  market_type       TEXT           NOT NULL CHECK (market_type IN ('WIN', 'WDO', 'ACOES', 'OPCOES')),
  side              TEXT           NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty               NUMERIC(18, 4) NOT NULL CHECK (qty > 0),
  price             NUMERIC(18, 4) NOT NULL CHECK (price >= 0),
  fees              NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  irrf              NUMERIC(18, 4) NOT NULL DEFAULT 0.0000,
  dedup_hash        CHAR(64)       NOT NULL,
  dedup_status      TEXT           NOT NULL DEFAULT 'NEW'
    CHECK (dedup_status IN ('NEW', 'EXACT_DUPLICATE', 'CONFLICT')),
  matched_trade_id  UUID           REFERENCES trades(id) ON DELETE SET NULL,
  diff_fields       TEXT[]         NOT NULL DEFAULT '{}',
  resolution_action TEXT           CHECK (resolution_action IN ('IGNORE', 'OVERWRITE', 'MERGE_COSTS')),
  raw_payload       JSONB          NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_items_user_job
  ON staging_items (user_id, job_id, row_number);

CREATE INDEX IF NOT EXISTS idx_staging_items_user_dedup
  ON staging_items (user_id, dedup_hash);

ALTER TABLE staging_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staging_items_tenant_isolation ON staging_items;
CREATE POLICY staging_items_tenant_isolation ON staging_items
  FOR ALL
  TO tradepilot_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- ----------------------------------------------------------------------------
-- 8. Privilégios mínimos para a role tradepilot_app (@spec SPEC-04, @rnf RNF-30)
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE users, audit_logs, trades, ingestion_jobs, staging_items FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users, trades, ingestion_jobs, staging_items TO tradepilot_app;

-- audit_logs: estritamente SELECT e INSERT (UPDATE, DELETE e TRUNCATE revogados)
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM tradepilot_app;
GRANT SELECT, INSERT ON TABLE audit_logs TO tradepilot_app;

COMMIT;
