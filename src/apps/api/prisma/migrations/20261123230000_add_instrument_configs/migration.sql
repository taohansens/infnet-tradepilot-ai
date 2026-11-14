-- ============================================================================
-- Prisma Migration: 20261123230000_add_instrument_configs
-- Projeto: TradePilot AI
-- Descrição: Tabela `instrument_configs` isolada por RLS (RNF-11) para
--            valor do ponto, tick e estimativa de custos (contrato, ordem, ISS)
--            em precisão exata NUMERIC(18,4).
--
-- @spec SPEC-06
-- @spec SPEC-10
-- @rnf RNF-11
-- @rnf RNF-20
-- ============================================================================

CREATE TABLE IF NOT EXISTS instrument_configs (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_type        TEXT           NOT NULL DEFAULT 'futuros'
    CHECK (asset_type IN ('futuros', 'acoes', 'opcoes')),
  contract_prefix   TEXT           NOT NULL,
  tick_size         NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (tick_size >= 0),
  point_value       NUMERIC(18, 4) NOT NULL DEFAULT 1.0000 CHECK (point_value > 0),
  cost_per_contract NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (cost_per_contract >= 0),
  cost_per_order    NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (cost_per_order >= 0),
  iss_percent       NUMERIC(18, 4) NOT NULL DEFAULT 0.0000 CHECK (iss_percent >= 0),
  is_active         BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_instrument_configs_user_prefix UNIQUE (user_id, contract_prefix)
);

CREATE INDEX IF NOT EXISTS idx_instrument_configs_user
  ON instrument_configs (user_id, contract_prefix);

ALTER TABLE instrument_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE instrument_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instrument_configs_tenant_isolation ON instrument_configs;
CREATE POLICY instrument_configs_tenant_isolation ON instrument_configs
  FOR ALL
  TO tradepilot_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

REVOKE ALL ON TABLE instrument_configs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE instrument_configs TO tradepilot_app;
