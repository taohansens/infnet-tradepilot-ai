import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de isolamento multi-tenant propagado por requisição via AsyncLocalStorage.
 * Garante que todas as operações de banco conheçam o `userId` autenticado para
 * injeção de `app.current_user_id` no PostgreSQL (Row-Level Security).
 *
 * @spec SPEC-01
 * @spec SPEC-04
 * @rf RF-T-1
 * @rnf RNF-11
 */
export interface RlsContext {
  readonly userId: string;
  readonly requestId: string;
  readonly ipHash?: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Erro lançado quando uma operação protegida por RLS tenta executar
 * sem um contexto de usuário válido (fail-closed).
 *
 * @rnf RNF-11
 */
export class RlsContextError extends Error {
  public readonly code = 'RLS_CONTEXT_MISSING';

  constructor(message = 'Contexto RLS ausente: app.current_user_id é obrigatório.') {
    super(message);
    this.name = 'RlsContextError';
  }
}

const rlsStorage = new AsyncLocalStorage<RlsContext>();

/**
 * Valida se a string é um UUID bem-formado antes de propagá-la ao PostgreSQL.
 *
 * @spec SPEC-01
 * @rnf RNF-11
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Executa um callback dentro de um escopo isolado de AsyncLocalStorage com o tenant atual.
 *
 * @spec SPEC-01
 * @rnf RNF-11
 */
export function runWithRlsContext<T>(context: RlsContext, fn: () => T): T {
  if (!isValidUuid(context.userId)) {
    throw new RlsContextError(`user_id inválido para contexto RLS: "${context.userId}".`);
  }
  return rlsStorage.run(context, fn);
}

/**
 * Retorna o contexto RLS atual, se existir.
 *
 * @rnf RNF-11
 */
export function getRlsContext(): RlsContext | undefined {
  return rlsStorage.getStore();
}

/**
 * Retorna o contexto RLS atual ou falha explicitamente (fail-closed).
 *
 * @rnf RNF-11
 */
export function getRequiredRlsContext(): RlsContext {
  const ctx = rlsStorage.getStore();
  if (!ctx || !isValidUuid(ctx.userId)) {
    throw new RlsContextError();
  }
  return ctx;
}
