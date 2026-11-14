import { Decimal } from 'decimal.js';
import * as XLSX from 'xlsx';
import {
  toDecimal,
  toNumeric4String,
  type InstrumentConfigDto,
  type MarketType,
  type OrderSide,
  type UploadSourceHint,
} from '@tradepilot/shared';
import {
  DEFAULT_B3_INSTRUMENT_CONFIGS,
  estimateFeesFromInstrumentConfig,
  resolveInstrumentConfigForTicker,
  resolvePointValue,
} from './instrumentService.js';

/**
 * Parser determinístico (estilo Taometria em Decimal exato) para:
 * 1. Livro de Ordens do Profit (ex.: 2311.csv) — reconstrói ciclos de trades fechados
 *    via FIFO por `(Corretora, Conta, Ativo)`, suportando parciais, reversão de mão,
 *    valor do ponto por contrato (WIN=0,20, WDO=10, IND=1, DOL=50, Ações=1) e estimativa
 *    de custos (`instrument_configs`: contrato + ordem + ISS%).
 * 2. Relatório de Performance do Profit e Extrato B3 ("Negociação de Ativos") em CSV/XLSX.
 *
 * Mensagens de erro em linguagem de negócio PT-BR (sem jargão técnico, TP2 p. 15).
 *
 * @spec SPEC-06
 * @rf RF-M1-5
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-20
 */

export class IngestionParseError extends Error {
  public readonly statusCode = 422;
  public readonly code = 'INGESTION_PARSE_ERROR';
  public readonly lineNumber?: number;

  constructor(messagePtBr: string, lineNumber?: number) {
    super(messagePtBr);
    this.name = 'IngestionParseError';
    this.lineNumber = lineNumber;
  }
}

export interface ReconstructedTradeMeta {
  entry_at: string;
  exit_at: string;
  exit_price: string;
  gross_pnl: string;
  setup_name: string | null;
  execution_count: number;
  execution_details: Array<{
    side: OrderSide;
    qty: string;
    price: string;
    executed_at: string;
    cl_ord_id: string | null;
  }>;
}

export interface ParsedStagingRow {
  rowNumber: number;
  broker: string | null;
  tradeDate: Date;
  executedAt: Date;
  ticker: string;
  marketType: MarketType;
  side: OrderSide;
  qty: string;
  price: string;
  fees: string;
  irrf: string;
  rawPayload: Record<string, unknown>;
}

function normalizeHeaderKey(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function detectCsvDelimiter(line: string): ',' | ';' | '\t' {
  const semicolons = (line.match(/;/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  if (tabs > semicolons && tabs > commas) return '\t';
  return semicolons >= commas ? ';' : ',';
}

function splitCsvLine(line: string, delimiter: ',' | ';' | '\t'): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Converte string monetária/numérica PT-BR ("R$ 166.285,00") ou EN ("5450.50")
 * para string decimal exata com 4 casas (`NUMERIC(18,4)`), zero float binário.
 *
 * @spec SPEC-06
 * @rnf RNF-20
 */
export function parseBrazilianDecimalString(
  raw: string,
  fieldLabel: string,
  lineNumber: number,
  allowEmptyZero = false,
): string {
  const cleaned = raw
    .replace(/R\$/gi, '')
    .replace(/\s+/g, '')
    .trim();

  if (cleaned.length === 0 || cleaned === '-' || cleaned === '--') {
    if (allowEmptyZero) return '0.0000';
    throw new IngestionParseError(
      `Inconsistência no Extrato da Corretora na linha ${lineNumber}: o campo "${fieldLabel}" está vazio.`,
      lineNumber,
    );
  }

  let normalized = cleaned;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    normalized = cleaned.replace(/\./g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new IngestionParseError(
      `Inconsistência no Extrato da Corretora na linha ${lineNumber}: valor inválido "${raw}" na coluna "${fieldLabel}".`,
      lineNumber,
    );
  }

  try {
    return toNumeric4String(toDecimal(normalized));
  } catch {
    throw new IngestionParseError(
      `Inconsistência no Extrato da Corretora na linha ${lineNumber}: não foi possível interpretar o número "${raw}" na coluna "${fieldLabel}".`,
      lineNumber,
    );
  }
}

export function inferMarketType(ticker: string): MarketType {
  const normalized = ticker.trim().toUpperCase();
  if (/^(WIN|IND)[A-Z]\d{2}$/.test(normalized) || normalized === 'WINFUT') {
    return 'WIN';
  }
  if (/^(WDO|DOL)[A-Z]\d{2}$/.test(normalized) || normalized === 'WDOFUT') {
    return 'WDO';
  }
  if (/^[A-Z]{4}[A-X]\d{2,3}$/.test(normalized)) {
    return 'OPCOES';
  }
  return 'ACOES';
}

function parseOrderSide(raw: string, lineNumber: number): OrderSide {
  const normalized = normalizeHeaderKey(raw);
  if (
    normalized === 'c' ||
    normalized === 'compra' ||
    normalized === 'buy' ||
    normalized === 'b' ||
    normalized === 'long'
  ) {
    return 'BUY';
  }
  if (
    normalized === 'v' ||
    normalized === 'venda' ||
    normalized === 'sell' ||
    normalized === 's' ||
    normalized === 'short'
  ) {
    return 'SELL';
  }
  throw new IngestionParseError(
    `Inconsistência no Extrato da Corretora na linha ${lineNumber}: lado da operação "${raw}" não reconhecido (esperado Compra/C ou Venda/V).`,
    lineNumber,
  );
}

function parseExecutionDateTime(raw: string, lineNumber: number): {
  tradeDate: Date;
  executedAt: Date;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new IngestionParseError(
      `Inconsistência no Extrato da Corretora na linha ${lineNumber}: data/hora da operação ausente.`,
      lineNumber,
    );
  }

  // Formato brasileiro: DD/MM/YYYY [HH:mm[:ss[.SSS]]]
  const brMatch = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (brMatch) {
    const [, dd, mm, yyyy, hh = '10', min = '00', ss = '00', ms = '000'] = brMatch;
    const msPadded = ms.padEnd(3, '0');
    const executedAt = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.${msPadded}-03:00`);
    const tradeDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    if (Number.isNaN(executedAt.getTime())) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: data "${raw}" inválida.`,
        lineNumber,
      );
    }
    return { tradeDate, executedAt };
  }

  // Formato ISO ou YYYY-MM-DD [HH:mm[:ss[.SSS]]]
  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/,
  );
  if (isoMatch) {
    const [, yyyy, mm, dd, hh = '10', min = '00', ss = '00', ms = '000', tz = '-03:00'] =
      isoMatch;
    const msPadded = ms.padEnd(3, '0');
    const executedAt = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.${msPadded}${tz}`);
    const tradeDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    if (Number.isNaN(executedAt.getTime())) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: data "${raw}" inválida.`,
        lineNumber,
      );
    }
    return { tradeDate, executedAt };
  }

  throw new IngestionParseError(
    `Inconsistência no Extrato da Corretora na linha ${lineNumber}: formato de data "${raw}" não reconhecido (use DD/MM/AAAA ou AAAA-MM-DD).`,
    lineNumber,
  );
}

interface ColumnMap {
  ticker: number;
  side: number;
  date: number;
  dateFallback: number;
  qty: number;
  qtyFallback: number;
  price: number;
  priceFallback: number;
  status: number;
  clOrdId: number;
  accountCode: number;
  setup: number;
  grossResult: number;
  broker: number;
  fees: number;
  irrf: number;
}

const COLUMN_ALIASES = {
  ticker: ['codigo de negociacao', 'ativo', 'ticker', 'papel', 'contrato', 'codigo'],
  side: ['lado', 'tipo de movimentacao', 'c v', 'direcao', 'operacao', 'side', 'tipo'],
  date: [
    'ultima atualizacao',
    'data do negocio',
    'data execucao',
    'data hora',
    'criacao',
    'abertura',
    'fechamento',
    'data pregao',
    'data',
    'executed at',
  ],
  dateFallback: ['criacao', 'abertura', 'data'],
  qty: ['qtd executada', 'quantidade', 'qtd', 'qtd compra', 'contratos', 'qty'],
  qtyFallback: ['qtd', 'quantidade', 'qtd venda', 'qty'],
  price: [
    'preco medio',
    'preco execucao',
    'preco unitario',
    'preco compra',
    'preco',
    'valor unitario',
    'price',
  ],
  priceFallback: ['preco', 'preco venda', 'preco unitario', 'price'],
  status: ['status', 'situacao'],
  clOrdId: ['clordid', 'clientorderid', 'idordem', 'id ordem'],
  accountCode: ['conta', 'account', 'accountcode'],
  setup: ['estrategia', 'setup', 'origem'],
  grossResult: ['resultado', 'resultado bruto', 'res operacao', 'res intervalo bruto', 'gross result', 'pnl'],
  broker: ['corretora', 'instituicao', 'broker'],
  fees: ['taxas', 'custos', 'corretagem', 'emolumentos', 'fees', 'taxa'],
  irrf: ['irrf', 'ir retido', 'imposto retido'],
} as const;

function tryResolveColumns(headers: string[]): { map: ColumnMap; missing: string[] } {
  const normalizedHeaders = headers.map(normalizeHeaderKey);

  const findIndex = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const exactIdx = normalizedHeaders.findIndex((h) => h === alias);
      if (exactIdx !== -1) return exactIdx;
    }
    for (const alias of aliases) {
      const partialIdx = normalizedHeaders.findIndex((h) => h.includes(alias));
      if (partialIdx !== -1) return partialIdx;
    }
    return -1;
  };

  const map: ColumnMap = {
    ticker: findIndex(COLUMN_ALIASES.ticker),
    side: findIndex(COLUMN_ALIASES.side),
    date: findIndex(COLUMN_ALIASES.date),
    dateFallback: findIndex(COLUMN_ALIASES.dateFallback),
    qty: findIndex(COLUMN_ALIASES.qty),
    qtyFallback: findIndex(COLUMN_ALIASES.qtyFallback),
    price: findIndex(COLUMN_ALIASES.price),
    priceFallback: findIndex(COLUMN_ALIASES.priceFallback),
    status: findIndex(COLUMN_ALIASES.status),
    clOrdId: findIndex(COLUMN_ALIASES.clOrdId),
    accountCode: findIndex(COLUMN_ALIASES.accountCode),
    setup: findIndex(COLUMN_ALIASES.setup),
    grossResult: findIndex(COLUMN_ALIASES.grossResult),
    broker: findIndex(COLUMN_ALIASES.broker),
    fees: findIndex(COLUMN_ALIASES.fees),
    irrf: findIndex(COLUMN_ALIASES.irrf),
  };

  const missing: string[] = [];
  if (map.ticker === -1) missing.push('Ativo / Código de Negociação');
  if (map.side === -1) missing.push('Lado (Compra/Venda)');
  if (map.date === -1) missing.push('Data do Negócio');
  if (map.qty === -1) missing.push('Quantidade');
  if (map.price === -1) missing.push('Preço');

  return { map, missing };
}

function decodeCsvBuffer(fileBuffer: Buffer): string {
  const utf8 = fileBuffer.toString('utf8').replace(/^\uFEFF/, '');
  if (utf8.includes('\uFFFD')) {
    return fileBuffer.toString('latin1').replace(/^\uFEFF/, '');
  }
  return utf8;
}

interface ExtractedTable {
  headers: string[];
  cols: ColumnMap;
  dataRows: Array<{ lineNumber: number; cells: string[] }>;
}

function locateHeaderAndExtract(
  rawLines: Array<{ lineNumber: number; text?: string; cells?: string[] }>,
  isCsv: boolean,
): ExtractedTable {
  const scanLimit = Math.min(rawLines.length, 15);
  let bestMissing: string[] = [
    'Ativo / Código de Negociação',
    'Lado (Compra/Venda)',
    'Data do Negócio',
    'Quantidade',
    'Preço',
  ];

  for (let i = 0; i < scanLimit; i += 1) {
    const entry = rawLines[i]!;
    const candidates: Array<{ delimiter?: ',' | ';' | '\t'; cells: string[] }> = isCsv
      ? [
          {
            delimiter: detectCsvDelimiter(entry.text ?? ''),
            cells: splitCsvLine(entry.text ?? '', detectCsvDelimiter(entry.text ?? '')),
          },
          { delimiter: ';', cells: splitCsvLine(entry.text ?? '', ';') },
          { delimiter: ',', cells: splitCsvLine(entry.text ?? '', ',') },
          { delimiter: '\t', cells: splitCsvLine(entry.text ?? '', '\t') },
        ]
      : [{ cells: entry.cells ?? [] }];

    for (const candidate of candidates) {
      const { map, missing } = tryResolveColumns(candidate.cells);
      if (missing.length === 0) {
        const dataRows: Array<{ lineNumber: number; cells: string[] }> = [];
        for (let j = i + 1; j < rawLines.length; j += 1) {
          const rowEntry = rawLines[j]!;
          const cells = isCsv
            ? splitCsvLine(rowEntry.text ?? '', candidate.delimiter ?? ';')
            : rowEntry.cells ?? [];
          dataRows.push({ lineNumber: rowEntry.lineNumber, cells });
        }
        return { headers: candidate.cells, cols: map, dataRows };
      }
      if (missing.length < bestMissing.length) {
        bestMissing = missing;
      }
    }
  }

  throw new IngestionParseError(
    `Inconsistência no Extrato da Corretora: colunas obrigatórias ausentes no cabeçalho (${bestMissing.join(', ')}).`,
    1,
  );
}

function extractTableFromBuffer(fileBuffer: Buffer, fileName: string): ExtractedTable {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const content = decodeCsvBuffer(fileBuffer);
    const rawLines = content
      .split(/\r?\n/)
      .map((line, idx) => ({ lineNumber: idx + 1, text: line.trim() }))
      .filter((entry) => entry.text.length > 0);

    if (rawLines.length === 0) {
      throw new IngestionParseError(
        'O arquivo enviado está vazio. Selecione um extrato com operações.',
      );
    }

    return locateHeaderAndExtract(rawLines, true);
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    try {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: false });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new IngestionParseError(
          'A planilha enviada não possui abas com dados de operações.',
        );
      }
      const sheet = workbook.Sheets[firstSheetName];
      if (!sheet) {
        throw new IngestionParseError(
          'Não foi possível ler a primeira aba da planilha enviada.',
        );
      }
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
      });
      const rawLines = rows
        .map((row, idx) => ({
          lineNumber: idx + 1,
          cells: row.map((cell) => String(cell ?? '').trim()),
        }))
        .filter((entry) => entry.cells.some((c) => c.length > 0));

      return locateHeaderAndExtract(rawLines, false);
    } catch (error) {
      if (error instanceof IngestionParseError) throw error;
      throw new IngestionParseError(
        'Não foi possível abrir o arquivo Excel. Verifique se o arquivo não está corrompido ou protegido por senha.',
      );
    }
  }

  throw new IngestionParseError(
    'Formato de arquivo não suportado. Envie um arquivo CSV ou XLSX do Extrato B3 ou do Profit.',
  );
}

function pickCell(row: string[], primaryIdx: number, fallbackIdx = -1): string {
  const primary = primaryIdx !== -1 ? (row[primaryIdx] ?? '').trim() : '';
  if (primary && primary !== '-' && primary !== '--') return primary;
  if (fallbackIdx !== -1) {
    const fb = (row[fallbackIdx] ?? '').trim();
    if (fb && fb !== '-' && fb !== '--') return fb;
  }
  return '';
}

function isExecutedStatus(rawStatus: string): boolean {
  const normalized = normalizeHeaderKey(rawStatus);
  if (!normalized) return true;
  return (
    normalized.startsWith('executad') ||
    normalized.includes('parcialmente executad') ||
    normalized.includes('filled') ||
    normalized.includes('liquidada') ||
    normalized.includes('concluid')
  );
}

interface OrderFill {
  rowNumber: number;
  broker: string | null;
  accountCode: string;
  ticker: string;
  marketType: MarketType;
  side: OrderSide;
  tradeDate: Date;
  executedAt: Date;
  qty: Decimal;
  price: Decimal;
  fees: Decimal;
  irrf: Decimal;
  clOrdId: string | null;
  setupName: string | null;
}

interface FifoLot {
  side: OrderSide;
  price: Decimal;
  qty: Decimal;
}

interface FifoCycle {
  firstRowNumber: number;
  broker: string | null;
  ticker: string;
  marketType: MarketType;
  side: OrderSide;
  startedAt: Date;
  endedAt: Date;
  tradeDate: Date;
  setupName: string | null;
  openedQty: Decimal;
  closedQty: Decimal;
  entryValueSum: Decimal;
  exitValueSum: Decimal;
  realizedPoints: Decimal;
  explicitFees: Decimal;
  explicitIrrf: Decimal;
  executionDetails: ReconstructedTradeMeta['execution_details'];
}

/**
 * Reconstrução de ciclos de trades fechados via FIFO por `(Corretora, Conta, Ativo)`,
 * portado do `importService.js` do Taometria e reescrito 100% em `Decimal` exato.
 * Suporta entradas parciais (ex.: 1+1=2) e reversões de mão.
 *
 * @spec SPEC-06
 * @rf RF-M1-5
 * @rnf RNF-20
 */
function reconstructTradesFifo(
  fills: OrderFill[],
  instrumentConfigs: InstrumentConfigDto[],
): ParsedStagingRow[] {
  const ordered = [...fills].sort(
    (a, b) => a.executedAt.getTime() - b.executedAt.getTime() || a.rowNumber - b.rowNumber,
  );

  const stateByKey = new Map<string, { lots: FifoLot[]; cycle: FifoCycle | null }>();
  const closedRows: ParsedStagingRow[] = [];

  function startCycle(fill: OrderFill): FifoCycle {
    return {
      firstRowNumber: fill.rowNumber,
      broker: fill.broker,
      ticker: fill.ticker,
      marketType: fill.marketType,
      side: fill.side,
      startedAt: fill.executedAt,
      endedAt: fill.executedAt,
      tradeDate: fill.tradeDate,
      setupName: fill.setupName,
      openedQty: toDecimal('0'),
      closedQty: toDecimal('0'),
      entryValueSum: toDecimal('0'),
      exitValueSum: toDecimal('0'),
      realizedPoints: toDecimal('0'),
      explicitFees: toDecimal('0'),
      explicitIrrf: toDecimal('0'),
      executionDetails: [],
    };
  }

  function flushCycle(cycle: FifoCycle): void {
    if (cycle.closedQty.lte(0)) return;

    const pointValueDec = toDecimal(resolvePointValue(instrumentConfigs, cycle.ticker));
    const grossPnlDec = cycle.realizedPoints.mul(pointValueDec);
    const avgEntryDec = cycle.openedQty.gt(0)
      ? cycle.entryValueSum.div(cycle.openedQty)
      : toDecimal('0');
    const avgExitDec = cycle.closedQty.gt(0)
      ? cycle.exitValueSum.div(cycle.closedQty)
      : avgEntryDec;

    const matchedConfig = resolveInstrumentConfigForTicker(
      instrumentConfigs,
      cycle.ticker,
    );
    const feesStr = estimateFeesFromInstrumentConfig({
      qty: toNumeric4String(cycle.openedQty),
      executionCount: cycle.executionDetails.length,
      baseFees: toNumeric4String(cycle.explicitFees),
      config: matchedConfig,
    });

    const meta: ReconstructedTradeMeta = {
      entry_at: cycle.startedAt.toISOString(),
      exit_at: cycle.endedAt.toISOString(),
      exit_price: toNumeric4String(avgExitDec),
      gross_pnl: toNumeric4String(grossPnlDec),
      setup_name: cycle.setupName,
      execution_count: cycle.executionDetails.length,
      execution_details: cycle.executionDetails,
    };

    closedRows.push({
      rowNumber: cycle.firstRowNumber,
      broker: cycle.broker,
      tradeDate: cycle.tradeDate,
      executedAt: cycle.endedAt,
      ticker: cycle.ticker,
      marketType: cycle.marketType,
      side: cycle.side,
      qty: toNumeric4String(cycle.openedQty),
      price: toNumeric4String(avgEntryDec),
      fees: feesStr,
      irrf: toNumeric4String(cycle.explicitIrrf),
      rawPayload: { _reconstructed: meta },
    });
  }

  for (const fill of ordered) {
    const key = `${fill.broker ?? ''}|${fill.accountCode}|${fill.ticker}`;
    const state = stateByKey.get(key) ?? { lots: [], cycle: null };
    const lots = state.lots;
    let cycle = state.cycle;
    let remaining = fill.qty;

    if (lots.length === 0 && !cycle) {
      cycle = startCycle(fill);
      state.cycle = cycle;
    }

    while (remaining.gt(0) && lots.length > 0 && lots[0]!.side !== fill.side && cycle) {
      const lot = lots[0]!;
      const matched = Decimal.min(remaining, lot.qty);

      if (lot.side === 'BUY' && fill.side === 'SELL') {
        cycle.realizedPoints = cycle.realizedPoints.plus(
          fill.price.minus(lot.price).mul(matched),
        );
      } else if (lot.side === 'SELL' && fill.side === 'BUY') {
        cycle.realizedPoints = cycle.realizedPoints.plus(
          lot.price.minus(fill.price).mul(matched),
        );
      }

      lot.qty = lot.qty.minus(matched);
      remaining = remaining.minus(matched);
      cycle.closedQty = cycle.closedQty.plus(matched);
      cycle.exitValueSum = cycle.exitValueSum.plus(fill.price.mul(matched));
      cycle.explicitFees = cycle.explicitFees.plus(fill.fees);
      cycle.explicitIrrf = cycle.explicitIrrf.plus(fill.irrf);
      cycle.endedAt = fill.executedAt;
      cycle.executionDetails.push({
        side: fill.side,
        qty: toNumeric4String(matched),
        price: toNumeric4String(fill.price),
        executed_at: fill.executedAt.toISOString(),
        cl_ord_id: fill.clOrdId,
      });

      if (lot.qty.lte(0)) {
        lots.shift();
      }
    }

    // Reversão de mão: zerou posição anterior e sobrou quantidade na direção oposta
    if (lots.length === 0 && cycle && cycle.closedQty.gt(0) && remaining.gt(0)) {
      flushCycle(cycle);
      cycle = null;
      state.cycle = null;
    }

    if (remaining.gt(0) && !cycle) {
      cycle = startCycle(fill);
      state.cycle = cycle;
    }

    if (remaining.gt(0) && cycle) {
      lots.push({ side: fill.side, price: fill.price, qty: remaining });
      cycle.openedQty = cycle.openedQty.plus(remaining);
      cycle.entryValueSum = cycle.entryValueSum.plus(fill.price.mul(remaining));
      cycle.explicitFees = cycle.explicitFees.plus(fill.fees);
      cycle.explicitIrrf = cycle.explicitIrrf.plus(fill.irrf);
      cycle.endedAt = fill.executedAt;
      if (!cycle.setupName && fill.setupName) cycle.setupName = fill.setupName;
      cycle.executionDetails.push({
        side: fill.side,
        qty: toNumeric4String(remaining),
        price: toNumeric4String(fill.price),
        executed_at: fill.executedAt.toISOString(),
        cl_ord_id: fill.clOrdId,
      });
    }

    if (lots.length === 0 && cycle && cycle.closedQty.gt(0)) {
      flushCycle(cycle);
      state.cycle = null;
    }

    state.lots = lots;
    stateByKey.set(key, state);
  }

  return closedRows;
}

/**
 * Executa o parsing completo do arquivo CSV/XLSX do Extrato B3 ou Profit
 * em linhas normalizadas prontas para o staging e motor de deduplicação.
 *
 * @spec SPEC-06
 * @rf RF-M1-5
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-20
 */
export function parseIngestionFile(params: {
  fileBuffer: Buffer;
  fileName: string;
  sourceHint: UploadSourceHint;
  instrumentConfigs?: InstrumentConfigDto[];
}): ParsedStagingRow[] {
  const configs =
    params.instrumentConfigs && params.instrumentConfigs.length > 0
      ? params.instrumentConfigs
      : DEFAULT_B3_INSTRUMENT_CONFIGS;

  const { headers, cols, dataRows } = extractTableFromBuffer(
    params.fileBuffer,
    params.fileName,
  );

  if (dataRows.length === 0) {
    throw new IngestionParseError(
      'O arquivo contém apenas o cabeçalho e nenhuma operação para importar.',
    );
  }

  // Detecta modo Livro de Ordens do Profit (possui coluna Status + ClOrdID/Qtd Executada)
  const isProfitOrderBook =
    cols.status !== -1 && cols.grossResult === -1;

  const fills: OrderFill[] = [];
  const directRows: ParsedStagingRow[] = [];

  for (const { lineNumber, cells: row } of dataRows) {
    if (row.every((cell) => cell.trim().length === 0)) {
      continue;
    }

    if (cols.status !== -1) {
      const statusText = row[cols.status] ?? '';
      if (!isExecutedStatus(statusText)) {
        continue;
      }
    }

    const rawTicker = (row[cols.ticker] ?? '').trim().toUpperCase();
    if (!rawTicker || !/^[A-Z0-9]{4,12}$/.test(rawTicker)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: código de ativo "${rawTicker || 'vazio'}" inválido.`,
        lineNumber,
      );
    }

    const side = parseOrderSide(row[cols.side] ?? '', lineNumber);
    const dateRaw = pickCell(row, cols.date, cols.dateFallback);
    const { tradeDate, executedAt } = parseExecutionDateTime(dateRaw, lineNumber);

    const qtyRaw = pickCell(row, cols.qty, cols.qtyFallback);
    const qty = parseBrazilianDecimalString(qtyRaw, 'Quantidade', lineNumber);
    if (toDecimal(qty).lte(0)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: a quantidade deve ser maior que zero.`,
        lineNumber,
      );
    }

    const priceRaw = pickCell(row, cols.price, cols.priceFallback);
    const price = parseBrazilianDecimalString(priceRaw, 'Preço', lineNumber);
    if (toDecimal(price).lt(0)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: o preço não pode ser negativo.`,
        lineNumber,
      );
    }

    const feesRaw = cols.fees !== -1 ? pickCell(row, cols.fees) : '';
    const fees = feesRaw
      ? parseBrazilianDecimalString(feesRaw, 'Taxas', lineNumber, true)
      : '0.0000';

    const irrfRaw = cols.irrf !== -1 ? pickCell(row, cols.irrf) : '';
    const irrf = irrfRaw
      ? parseBrazilianDecimalString(irrfRaw, 'IRRF', lineNumber, true)
      : '0.0000';

    const broker =
      cols.broker !== -1 && (row[cols.broker] ?? '').trim().length > 0
        ? (row[cols.broker] ?? '').trim()
        : params.sourceHint === 'PROFIT_CSV'
          ? 'Profit'
          : 'B3';

    const rawSetup = cols.setup !== -1 ? (row[cols.setup] ?? '').trim() : '';
    const setupName =
      rawSetup && rawSetup !== '-' && rawSetup.toLowerCase() !== 'normal'
        ? rawSetup
        : null;

    if (isProfitOrderBook) {
      fills.push({
        rowNumber: lineNumber,
        broker,
        accountCode:
          cols.accountCode !== -1 ? (row[cols.accountCode] ?? '').trim() : '',
        ticker: rawTicker,
        marketType: inferMarketType(rawTicker),
        side,
        tradeDate,
        executedAt,
        qty: toDecimal(qty),
        price: toDecimal(price),
        fees: toDecimal(fees),
        irrf: toDecimal(irrf),
        clOrdId: cols.clOrdId !== -1 ? (row[cols.clOrdId] ?? '').trim() || null : null,
        setupName,
      });
    } else {
      const rawPayload: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        if (h) rawPayload[h] = row[idx] ?? '';
      });

      // Se for Relatório de Performance do Profit (possui coluna Resultado), preserva gross_pnl
      if (cols.grossResult !== -1) {
        const grossRaw = pickCell(row, cols.grossResult);
        const grossPnl = grossRaw
          ? parseBrazilianDecimalString(grossRaw, 'Resultado', lineNumber, true)
          : '0.0000';
        const matchedConfig = resolveInstrumentConfigForTicker(configs, rawTicker);
        const appliedFees = estimateFeesFromInstrumentConfig({
          qty,
          executionCount: 1,
          baseFees: fees,
          config: matchedConfig,
        });

        rawPayload._reconstructed = {
          entry_at: executedAt.toISOString(),
          exit_at: executedAt.toISOString(),
          exit_price: price,
          gross_pnl: grossPnl,
          setup_name: setupName,
          execution_count: 1,
          execution_details: [],
        } satisfies ReconstructedTradeMeta;

        directRows.push({
          rowNumber: lineNumber,
          broker,
          tradeDate,
          executedAt,
          ticker: rawTicker,
          marketType: inferMarketType(rawTicker),
          side,
          qty,
          price,
          fees: appliedFees,
          irrf,
          rawPayload,
        });
      } else {
        directRows.push({
          rowNumber: lineNumber,
          broker,
          tradeDate,
          executedAt,
          ticker: rawTicker,
          marketType: inferMarketType(rawTicker),
          side,
          qty,
          price,
          fees,
          irrf,
          rawPayload,
        });
      }
    }
  }

  if (isProfitOrderBook) {
    if (fills.length === 0) {
      throw new IngestionParseError(
        'Nenhuma ordem executada foi encontrada no arquivo do Profit.',
      );
    }

    const reconstructed = reconstructTradesFifo(fills, configs);
    if (reconstructed.length > 0) {
      return reconstructed;
    }

    // Fallback para arquivo parcial de 1 perna sem fechamento (mantém prévia de execução)
    return fills.map((f) => ({
      rowNumber: f.rowNumber,
      broker: f.broker,
      tradeDate: f.tradeDate,
      executedAt: f.executedAt,
      ticker: f.ticker,
      marketType: f.marketType,
      side: f.side,
      qty: toNumeric4String(f.qty),
      price: toNumeric4String(f.price),
      fees: toNumeric4String(f.fees),
      irrf: toNumeric4String(f.irrf),
      rawPayload: { cl_ord_id: f.clOrdId },
    }));
  }

  if (directRows.length === 0) {
    throw new IngestionParseError(
      'Nenhuma operação válida foi encontrada no arquivo enviado.',
    );
  }

  return directRows;
}
