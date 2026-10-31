import * as XLSX from 'xlsx';
import {
  toDecimal,
  toNumeric4String,
  type MarketType,
  type OrderSide,
  type UploadSourceHint,
} from '@tradepilot/shared';

/**
 * Parser determinístico para Extrato B3 ("Negociação de Ativos") e Ordens do Profit
 * em formatos CSV e XLSX, com mensagens de erro em linguagem de negócio PT-BR
 * (sem jargão técnico) e aritmética estritamente em Decimal.
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
  rawPayload: Record<string, string>;
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

function detectCsvDelimiter(firstLine: string): ',' | ';' {
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semicolons >= commas ? ';' : ',';
}

function splitCsvLine(line: string, delimiter: ',' | ';'): string[] {
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
 * Converte string monetária/numérica em formato PT-BR ("R$ 5.450,50") ou EN ("5450.50")
 * para string decimal exata com 4 casas (`NUMERIC(18,4)`), sem float binário.
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

  if (cleaned.length === 0) {
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
    // Ex.: "5.450,50" -> "5450.50" ou "5,450.50" -> "5450.50"
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    // Ex.: "131.200" (separador de milhar PT-BR sem casas decimais)
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

/**
 * Infere o tipo de mercado B3 a partir do código de negociação (ticker).
 *
 * @spec SPEC-06
 * @spec SPEC-10
 */
export function inferMarketType(ticker: string): MarketType {
  const normalized = ticker.trim().toUpperCase();
  if (/^WIN[A-Z]\d{2}$/.test(normalized) || normalized === 'WINFUT') {
    return 'WIN';
  }
  if (/^WDO[A-Z]\d{2}$/.test(normalized) || normalized === 'WDOFUT') {
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

  // Formato brasileiro: DD/MM/YYYY [HH:mm[:ss]]
  const brMatch = trimmed.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (brMatch) {
    const [, dd, mm, yyyy, hh = '10', min = '00', ss = '00'] = brMatch;
    const isoBrt = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}-03:00`;
    const executedAt = new Date(isoBrt);
    const tradeDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
    if (Number.isNaN(executedAt.getTime())) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: data "${raw}" inválida.`,
        lineNumber,
      );
    }
    return { tradeDate, executedAt };
  }

  // Formato ISO ou YYYY-MM-DD [HH:mm[:ss]]
  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/,
  );
  if (isoMatch) {
    const [, yyyy, mm, dd, hh = '10', min = '00', ss = '00', tz = '-03:00'] =
      isoMatch;
    const executedAt = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${tz}`);
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
  qty: number;
  price: number;
  broker: number;
  fees: number;
  irrf: number;
}

const COLUMN_ALIASES: Record<keyof ColumnMap, string[]> = {
  ticker: ['codigo de negociacao', 'codigo', 'ativo', 'ticker', 'papel'],
  side: ['tipo de movimentacao', 'c v', 'lado', 'operacao', 'side', 'tipo'],
  date: [
    'data do negocio',
    'data hora',
    'abertura',
    'data execucao',
    'data pregao',
    'data',
    'executed at',
  ],
  qty: ['quantidade', 'qtd', 'qtd compra', 'qtd executada', 'contratos', 'qty'],
  price: [
    'preco',
    'preco unitario',
    'preco medio',
    'preco execucao',
    'valor unitario',
    'price',
  ],
  broker: ['instituicao', 'corretora', 'broker'],
  fees: ['taxas', 'custos', 'corretagem', 'emolumentos', 'fees', 'taxa'],
  irrf: ['irrf', 'ir retido', 'imposto retido'],
};

function resolveColumns(headers: string[]): ColumnMap {
  const normalizedHeaders = headers.map(normalizeHeaderKey);

  const findIndex = (aliases: string[]): number => {
    for (const alias of aliases) {
      const idx = normalizedHeaders.findIndex(
        (h) => h === alias || h.includes(alias),
      );
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const map: ColumnMap = {
    ticker: findIndex(COLUMN_ALIASES.ticker),
    side: findIndex(COLUMN_ALIASES.side),
    date: findIndex(COLUMN_ALIASES.date),
    qty: findIndex(COLUMN_ALIASES.qty),
    price: findIndex(COLUMN_ALIASES.price),
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

  if (missing.length > 0) {
    throw new IngestionParseError(
      `Inconsistência no Extrato da Corretora: colunas obrigatórias ausentes no cabeçalho (${missing.join(', ')}).`,
      1,
    );
  }

  return map;
}

function extractMatrixFromBuffer(fileBuffer: Buffer, fileName: string): string[][] {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const content = fileBuffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      throw new IngestionParseError(
        'O arquivo enviado está vazio. Selecione um extrato com operações.',
      );
    }

    const delimiter = detectCsvDelimiter(lines[0] ?? '');
    return lines.map((line) => splitCsvLine(line, delimiter));
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
      return rows.map((row) => row.map((cell) => String(cell ?? '').trim()));
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
}): ParsedStagingRow[] {
  const matrix = extractMatrixFromBuffer(params.fileBuffer, params.fileName);

  if (matrix.length < 2) {
    throw new IngestionParseError(
      'O arquivo contém apenas o cabeçalho e nenhuma operação para importar.',
    );
  }

  const headers = matrix[0] ?? [];
  const cols = resolveColumns(headers);
  const parsed: ParsedStagingRow[] = [];

  for (let i = 1; i < matrix.length; i += 1) {
    const row = matrix[i] ?? [];
    const lineNumber = i + 1; // Linha 1-based no arquivo original

    if (row.every((cell) => cell.trim().length === 0)) {
      continue;
    }

    const rawTicker = (row[cols.ticker] ?? '').trim().toUpperCase();
    if (!rawTicker || !/^[A-Z0-9]{4,12}$/.test(rawTicker)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: código de ativo "${rawTicker || 'vazio'}" inválido.`,
        lineNumber,
      );
    }

    const side = parseOrderSide(row[cols.side] ?? '', lineNumber);
    const { tradeDate, executedAt } = parseExecutionDateTime(
      row[cols.date] ?? '',
      lineNumber,
    );

    const qty = parseBrazilianDecimalString(
      row[cols.qty] ?? '',
      'Quantidade',
      lineNumber,
    );
    if (toDecimal(qty).lte(0)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: a quantidade deve ser maior que zero.`,
        lineNumber,
      );
    }

    const price = parseBrazilianDecimalString(
      row[cols.price] ?? '',
      'Preço',
      lineNumber,
    );
    if (toDecimal(price).lt(0)) {
      throw new IngestionParseError(
        `Inconsistência no Extrato da Corretora na linha ${lineNumber}: o preço não pode ser negativo.`,
        lineNumber,
      );
    }

    const fees =
      cols.fees !== -1
        ? parseBrazilianDecimalString(row[cols.fees] ?? '', 'Taxas', lineNumber, true)
        : '0.0000';

    const irrf =
      cols.irrf !== -1
        ? parseBrazilianDecimalString(row[cols.irrf] ?? '', 'IRRF', lineNumber, true)
        : '0.0000';

    const broker =
      cols.broker !== -1 && (row[cols.broker] ?? '').trim().length > 0
        ? (row[cols.broker] ?? '').trim()
        : params.sourceHint === 'PROFIT_CSV'
          ? 'Profit'
          : 'B3';

    const rawPayload: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) rawPayload[h] = row[idx] ?? '';
    });

    parsed.push({
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

  if (parsed.length === 0) {
    throw new IngestionParseError(
      'Nenhuma operação válida foi encontrada no arquivo enviado.',
    );
  }

  return parsed;
}
