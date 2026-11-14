import {
  toDecimal,
  toNumeric4String,
  type InstrumentConfigDto,
} from '@tradepilot/shared';
import { getRequiredRlsContext } from '../db/rlsContext.js';
import { runInRlsTransaction } from '../db/prismaRls.js';

/**
 * Serviço de Configuração de Contratos/Instrumentos B3 por usuário (valor do ponto,
 * tamanho do tick, custo por contrato, custo por ordem e ISS) — inspirado no Taometria.
 *
 * @spec SPEC-06
 * @spec SPEC-10
 * @rnf RNF-11
 * @rnf RNF-20
 */

export class InstrumentServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'InstrumentServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const DEFAULT_B3_INSTRUMENT_CONFIGS: InstrumentConfigDto[] = [
  {
    asset_type: 'futuros',
    contract_prefix: 'WIN',
    tick_size: '5.0000',
    point_value: '0.2000',
    cost_per_contract: '0.0000',
    cost_per_order: '0.0000',
    iss_percent: '0.0000',
    is_active: true,
  },
  {
    asset_type: 'futuros',
    contract_prefix: 'WDO',
    tick_size: '0.5000',
    point_value: '10.0000',
    cost_per_contract: '0.0000',
    cost_per_order: '0.0000',
    iss_percent: '0.0000',
    is_active: true,
  },
  {
    asset_type: 'futuros',
    contract_prefix: 'IND',
    tick_size: '5.0000',
    point_value: '1.0000',
    cost_per_contract: '0.0000',
    cost_per_order: '0.0000',
    iss_percent: '0.0000',
    is_active: true,
  },
  {
    asset_type: 'futuros',
    contract_prefix: 'DOL',
    tick_size: '0.5000',
    point_value: '50.0000',
    cost_per_contract: '0.0000',
    cost_per_order: '0.0000',
    iss_percent: '0.0000',
    is_active: true,
  },
  {
    asset_type: 'acoes',
    contract_prefix: 'ACOES',
    tick_size: '0.0100',
    point_value: '1.0000',
    cost_per_contract: '0.0000',
    cost_per_order: '0.0000',
    iss_percent: '0.0000',
    is_active: true,
  },
];

/**
 * Resolve a configuração de instrumento mais específica para um ticker B3
 * (ex.: `WINZ26` -> `WIN`, `WDOX26` -> `WDO`, `PETR4` -> `ACOES`).
 *
 * @spec SPEC-06
 * @rnf RNF-20
 */
export function resolveInstrumentConfigForTicker(
  configs: InstrumentConfigDto[],
  ticker: string,
): InstrumentConfigDto | null {
  const active = configs.filter((c) => c.is_active);
  const normalized = ticker.trim().toUpperCase();

  const prefixMatch = active
    .filter(
      (c) =>
        c.contract_prefix !== 'ACOES' &&
        normalized.startsWith(c.contract_prefix.toUpperCase()),
    )
    .sort((a, b) => b.contract_prefix.length - a.contract_prefix.length)[0];

  if (prefixMatch) return prefixMatch;

  return active.find((c) => c.contract_prefix.toUpperCase() === 'ACOES') ?? null;
}

/**
 * Retorna o valor do ponto em R$ como string decimal exata (`NUMERIC(18,4)`).
 *
 * @spec SPEC-06
 * @rnf RNF-20
 */
export function resolvePointValue(
  configs: InstrumentConfigDto[],
  ticker: string,
): string {
  const matched = resolveInstrumentConfigForTicker(configs, ticker);
  if (matched) return toNumeric4String(matched.point_value);

  const upper = ticker.trim().toUpperCase();
  if (upper.startsWith('WDO')) return '10.0000';
  if (upper.startsWith('DOL')) return '50.0000';
  if (upper.startsWith('WIN')) return '0.2000';
  if (upper.startsWith('IND')) return '1.0000';
  return '1.0000';
}

/**
 * Estima custos operacionais em `Decimal` exato (contrato + ordem + ISS%)
 * quando o arquivo importado não fornece coluna explícita de taxas.
 *
 * @spec SPEC-06
 * @rnf RNF-20
 */
export function estimateFeesFromInstrumentConfig(params: {
  qty: string;
  executionCount: number;
  baseFees: string;
  config: InstrumentConfigDto | null;
}): string {
  const baseDec = toDecimal(params.baseFees);
  if (baseDec.gt(0)) {
    return toNumeric4String(baseDec);
  }
  if (!params.config) {
    return '0.0000';
  }

  const qtyDec = toDecimal(params.qty);
  const ordersDec = toDecimal(String(Math.max(1, params.executionCount)));
  const costContract = toDecimal(params.config.cost_per_contract);
  const costOrder = toDecimal(params.config.cost_per_order);
  const issPct = toDecimal(params.config.iss_percent);

  const subtotal = qtyDec.mul(costContract).plus(ordersDec.mul(costOrder));
  const iss = subtotal.mul(issPct).div('100');
  return toNumeric4String(subtotal.plus(iss));
}

interface RawInstrumentRow {
  id: string;
  asset_type: string;
  contract_prefix: string;
  tick_size: unknown;
  point_value: unknown;
  cost_per_contract: unknown;
  cost_per_order: unknown;
  iss_percent: unknown;
  is_active: boolean;
}

function mapRawRow(row: RawInstrumentRow): InstrumentConfigDto {
  return {
    id: row.id,
    asset_type: (row.asset_type === 'acoes' || row.asset_type === 'opcoes'
      ? row.asset_type
      : 'futuros') as InstrumentConfigDto['asset_type'],
    contract_prefix: row.contract_prefix,
    tick_size: toNumeric4String(String(row.tick_size ?? '0')),
    point_value: toNumeric4String(String(row.point_value ?? '1')),
    cost_per_contract: toNumeric4String(String(row.cost_per_contract ?? '0')),
    cost_per_order: toNumeric4String(String(row.cost_per_order ?? '0')),
    iss_percent: toNumeric4String(String(row.iss_percent ?? '0')),
    is_active: Boolean(row.is_active),
  };
}

export class InstrumentService {
  /**
   * Lista configurações de instrumentos do usuário autenticado (sob RLS),
   * inicializando os padrões B3 (WIN, WDO, IND, DOL, ACOES) no primeiro acesso.
   *
   * @spec SPEC-06
   * @rnf RNF-11
   */
  public async listUserConfigs(): Promise<InstrumentConfigDto[]> {
    const ctx = getRequiredRlsContext();

    return runInRlsTransaction(async (tx) => {
      const existing = await tx.$queryRaw<RawInstrumentRow[]>`
        SELECT id, asset_type, contract_prefix, tick_size, point_value,
               cost_per_contract, cost_per_order, iss_percent, is_active
        FROM instrument_configs
        ORDER BY contract_prefix ASC
      `;

      if (existing.length > 0) {
        return existing.map(mapRawRow);
      }

      for (const def of DEFAULT_B3_INSTRUMENT_CONFIGS) {
        await tx.$executeRaw`
          INSERT INTO instrument_configs (
            user_id, asset_type, contract_prefix, tick_size, point_value,
            cost_per_contract, cost_per_order, iss_percent, is_active
          ) VALUES (
            ${ctx.userId}::uuid,
            ${def.asset_type},
            ${def.contract_prefix},
            ${def.tick_size}::numeric,
            ${def.point_value}::numeric,
            ${def.cost_per_contract}::numeric,
            ${def.cost_per_order}::numeric,
            ${def.iss_percent}::numeric,
            ${def.is_active}
          )
          ON CONFLICT (user_id, contract_prefix) DO NOTHING
        `;
      }

      const seeded = await tx.$queryRaw<RawInstrumentRow[]>`
        SELECT id, asset_type, contract_prefix, tick_size, point_value,
               cost_per_contract, cost_per_order, iss_percent, is_active
        FROM instrument_configs
        ORDER BY contract_prefix ASC
      `;
      return seeded.map(mapRawRow);
    });
  }

  /**
   * Salva configurações de contratos/custos do usuário em transação atômica sob RLS.
   *
   * @spec SPEC-06
   * @rnf RNF-11
   * @rnf RNF-20
   */
  public async saveUserConfigs(
    items: InstrumentConfigDto[],
  ): Promise<InstrumentConfigDto[]> {
    const ctx = getRequiredRlsContext();
    if (!Array.isArray(items) || items.length === 0) {
      throw new InstrumentServiceError(
        400,
        'EMPTY_INSTRUMENTS',
        'Informe ao menos uma configuração de contrato/instrumento.',
      );
    }

    const sanitized: InstrumentConfigDto[] = items.map((item) => {
      const prefix = String(item.contract_prefix ?? '').trim().toUpperCase();
      if (!prefix || !/^[A-Z0-9]{2,10}$/.test(prefix)) {
        throw new InstrumentServiceError(
          400,
          'INVALID_PREFIX',
          `Prefixo de contrato inválido: "${prefix || 'vazio'}".`,
        );
      }

      const pointValue = toNumeric4String(String(item.point_value ?? '1').replace(',', '.'));
      if (toDecimal(pointValue).lte(0)) {
        throw new InstrumentServiceError(
          400,
          'INVALID_POINT_VALUE',
          `O valor do ponto de ${prefix} deve ser maior que zero.`,
        );
      }

      const tickSize = toNumeric4String(String(item.tick_size ?? '0').replace(',', '.'));
      const costContract = toNumeric4String(
        String(item.cost_per_contract ?? '0').replace(',', '.'),
      );
      const costOrder = toNumeric4String(
        String(item.cost_per_order ?? '0').replace(',', '.'),
      );
      const issPercent = toNumeric4String(
        String(item.iss_percent ?? '0').replace(',', '.'),
      );

      if (
        toDecimal(tickSize).lt(0) ||
        toDecimal(costContract).lt(0) ||
        toDecimal(costOrder).lt(0) ||
        toDecimal(issPercent).lt(0)
      ) {
        throw new InstrumentServiceError(
          400,
          'NEGATIVE_COST',
          `Valores negativos não são permitidos na configuração de ${prefix}.`,
        );
      }

      return {
        asset_type:
          item.asset_type === 'acoes' || item.asset_type === 'opcoes'
            ? item.asset_type
            : 'futuros',
        contract_prefix: prefix,
        tick_size: tickSize,
        point_value: pointValue,
        cost_per_contract: costContract,
        cost_per_order: costOrder,
        iss_percent: issPercent,
        is_active: item.is_active !== false,
      };
    });

    return runInRlsTransaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM instrument_configs WHERE user_id = ${ctx.userId}::uuid`;

      for (const cfg of sanitized) {
        await tx.$executeRaw`
          INSERT INTO instrument_configs (
            user_id, asset_type, contract_prefix, tick_size, point_value,
            cost_per_contract, cost_per_order, iss_percent, is_active
          ) VALUES (
            ${ctx.userId}::uuid,
            ${cfg.asset_type},
            ${cfg.contract_prefix},
            ${cfg.tick_size}::numeric,
            ${cfg.point_value}::numeric,
            ${cfg.cost_per_contract}::numeric,
            ${cfg.cost_per_order}::numeric,
            ${cfg.iss_percent}::numeric,
            ${cfg.is_active}
          )
        `;
      }

      const saved = await tx.$queryRaw<RawInstrumentRow[]>`
        SELECT id, asset_type, contract_prefix, tick_size, point_value,
               cost_per_contract, cost_per_order, iss_percent, is_active
        FROM instrument_configs
        ORDER BY contract_prefix ASC
      `;
      return saved.map(mapRawRow);
    });
  }
}

export const instrumentService = new InstrumentService();
