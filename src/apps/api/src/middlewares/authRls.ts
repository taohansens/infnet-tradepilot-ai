import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import {
  isValidUuid,
  runWithRlsContext,
  type RlsContext,
} from '../db/rlsContext.js';
import {
  runInRlsTransaction,
  type RlsTransactionClient,
} from '../db/prismaRls.js';

/**
 * Payload esperado no Access Token JWT emitido pelo módulo de autenticação.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-11
 * @rnf RNF-12
 */
export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  email?: string;
  plan_status?: 'trial' | 'active' | 'past_due' | 'canceled';
}

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email?: string;
  readonly planStatus?: 'trial' | 'active' | 'past_due' | 'canceled';
  readonly requestId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
      runInRlsTransaction?: <T>(
        fn: (tx: RlsTransactionClient, ctx: RlsContext) => Promise<T>,
      ) => Promise<T>;
    }
  }
}

export interface AuthRlsMiddlewareOptions {
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
}

/**
 * Gera hash SHA-256 truncado do endereço IP do cliente para trilha de auditoria
 * sem expor o IP em texto claro (minimização de dados LGPD).
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rnf RNF-13
 */
function hashClientIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Extrai o token Bearer do cabeçalho `Authorization`.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 */
function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.trim().split(/\s+/);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return token;
}

/**
 * Middleware Express de autenticação JWT + propagação de isolamento RLS (PostgreSQL).
 *
 * Fluxo executado em cada requisição protegida:
 * 1. Valida o JWT (`Authorization: Bearer <token>`) com assinatura, issuer e audience.
 * 2. Valida que `claims.sub` é um UUID válido de usuário (`user_id`).
 * 3. Inicializa o contexto `AsyncLocalStorage` com `userId`, `requestId` e `ipHash`.
 * 4. Anexa `req.auth` e `req.runInRlsTransaction` (que injeta `app.current_user_id`
 *    via `set_config(..., true)` na transação PostgreSQL).
 * 5. O cliente `prismaRls` também lê automaticamente este contexto em qualquer consulta.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 */
export function createAuthRlsMiddleware(options: AuthRlsMiddlewareOptions = {}) {
  return function authRlsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Token de autenticação ausente ou malformado.',
      });
      return;
    }

    const secret = options.jwtSecret ?? process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({
        error: 'AUTH_CONFIG_ERROR',
        message: 'Configuração de autenticação indisponível no servidor.',
      });
      return;
    }

    let payload: AccessTokenClaims;
    try {
      const verified = jwt.verify(token, secret, {
        issuer: options.jwtIssuer ?? process.env.JWT_ISSUER ?? 'tradepilot-ai',
        audience: options.jwtAudience ?? process.env.JWT_AUDIENCE ?? 'tradepilot-ai-web',
      });

      if (typeof verified === 'string' || !verified.sub) {
        res.status(401).json({
          error: 'INVALID_TOKEN_CLAIMS',
          message: 'Token JWT inválido: identificador de usuário ausente.',
        });
        return;
      }

      payload = verified as AccessTokenClaims;
    } catch {
      res.status(401).json({
        error: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Sessão inválida ou expirada. Faça login novamente.',
      });
      return;
    }

    if (!isValidUuid(payload.sub)) {
      res.status(401).json({
        error: 'INVALID_SUBJECT',
        message: 'Identificador de usuário inválido no token.',
      });
      return;
    }

    const requestIdHeader = req.headers['x-request-id'];
    const requestId =
      typeof requestIdHeader === 'string' && requestIdHeader.trim().length > 0
        ? requestIdHeader.trim()
        : randomUUID();

    const rlsContext: RlsContext = {
      userId: payload.sub,
      requestId,
      ipHash: hashClientIp(req.ip),
    };

    req.auth = {
      userId: payload.sub,
      email: payload.email,
      planStatus: payload.plan_status,
      requestId,
    };

    req.runInRlsTransaction = <T>(
      fn: (tx: RlsTransactionClient, ctx: RlsContext) => Promise<T>,
    ): Promise<T> => runInRlsTransaction(fn, undefined, rlsContext);

    // Mantém o contexto RLS ativo durante todo o ciclo assíncrono dos próximos handlers
    runWithRlsContext(rlsContext, () => {
      next();
    });
  };
}

export const authRlsMiddleware = createAuthRlsMiddleware();
