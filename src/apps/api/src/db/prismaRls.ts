import { Prisma, PrismaClient } from '@prisma/client';
import { getRequiredRlsContext, type RlsContext } from './rlsContext.js';

/**
 * Cliente base do Prisma conectado com a role `tradepilot_app` (NOBYPASSRLS).
 * Não deve ser usado diretamente em consultas multi-tenant sem transação RLS.
 *
 * @spec SPEC-01
 * @rnf RNF-11
 */
export const basePrisma = new PrismaClient();

export type RlsTransactionClient = Prisma.TransactionClient;

/**
 * Injeta `app.current_user_id` na transação PostgreSQL corrente usando
 * `set_config(..., is_local => true)`, equivalente seguro e parametrizado a `SET LOCAL`.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-11
 */
export async function applyRlsSessionConfig(
  tx: RlsTransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
}

/**
 * Executa um bloco atômico dentro de uma única transação PostgreSQL com
 * `app.current_user_id` configurado via `set_config(..., true)`.
 *
 * Ideal para operações compostas que precisam gravar entidade + registro
 * imutável em `audit_logs` atomicamente (ex.: edição de trade + SPEC-04,
 * commit de conciliação SPEC-09).
 *
 * @spec SPEC-01
 * @spec SPEC-04
 * @spec SPEC-09
 * @rnf RNF-9
 * @rnf RNF-11
 * @rnf RNF-30
 */
export async function runInRlsTransaction<T>(
  fn: (tx: RlsTransactionClient, ctx: RlsContext) => Promise<T>,
  client: PrismaClient = basePrisma,
  explicitContext?: RlsContext,
): Promise<T> {
  const ctx = explicitContext ?? getRequiredRlsContext();

  return client.$transaction(async (tx) => {
    await applyRlsSessionConfig(tx, ctx.userId);
    return fn(tx, ctx);
  });
}

/**
 * Cria uma instância estendida do Prisma Client (`$extends`) que envolve
 * automaticamente qualquer operação de leitura/escrita em uma transação
 * PostgreSQL com `set_config('app.current_user_id', userId, true)` obtido do
 * `AsyncLocalStorage` da requisição.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-11
 */
export function createRlsPrismaClient(client: PrismaClient = basePrisma) {
  return client.$extends({
    name: 'tradepilot-rls-isolation',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const ctx = getRequiredRlsContext();

          // Executa set_config e a operação dentro da mesma transação no pool
          const [, result] = await client.$transaction([
            client.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`,
            query(args),
          ]);

          return result;
        },
      },
    },
  });
}

export const prismaRls = createRlsPrismaClient(basePrisma);
