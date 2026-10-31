import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, type AuditAction, type AuditEntityType } from '@tradepilot/shared';
import { authRlsMiddleware } from './middlewares/authRls.js';
import { auditService } from './services/auditService.js';
import { RlsContextError } from './db/rlsContext.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createIngestionRouter } from './routes/ingestionRoutes.js';
import { createPrivacyRouter } from './routes/privacyRoutes.js';

/**
 * Aplicação Express do backend TradePilot AI com rotas de Autenticação (SPEC-01),
 * Privacidade/LGPD (SPEC-03) e Trilha de Auditoria Imutável (SPEC-04).
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-1
 * @rf RF-T-4
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 * @rnf RNF-13
 * @rnf RNF-30
 */
export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'tradepilot-api',
      timestamp_utc: new Date().toISOString(),
    });
  });

  // Rotas públicas de autenticação (SPEC-01)
  app.use('/api/v1/auth', createAuthRouter());

  // Rotas autenticadas de privacidade e LGPD (SPEC-03)
  app.use('/api/v1/privacy', authRlsMiddleware, createPrivacyRouter());

  // Rotas autenticadas de ingestão assíncrona e conciliação (SPEC-06, SPEC-08, SPEC-09)
  app.use('/api/v1/ingestion', authRlsMiddleware, createIngestionRouter());

  /**
   * Consulta somente-leitura da trilha de auditoria imutável do usuário autenticado.
   *
   * @spec SPEC-04
   * @rnf RNF-11
   * @rnf RNF-15
   * @rnf RNF-30
   */
  app.get('/api/v1/audit-logs', authRlsMiddleware, async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitParam) ? limitParam : 50;

      const rawAction =
        typeof req.query.action === 'string' ? req.query.action : undefined;
      const action =
        rawAction && AUDIT_ACTIONS.includes(rawAction as AuditAction)
          ? (rawAction as AuditAction)
          : undefined;

      const rawEntityType =
        typeof req.query.entity_type === 'string'
          ? req.query.entity_type
          : undefined;
      const entityType =
        rawEntityType &&
        AUDIT_ENTITY_TYPES.includes(rawEntityType as AuditEntityType)
          ? (rawEntityType as AuditEntityType)
          : undefined;

      const logs = await auditService.listAuditEvents({
        limit,
        action,
        entityType,
      });
      res.status(200).json({ items: logs });
    } catch (error) {
      next(error);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RlsContextError) {
      res.status(401).json({
        error: err.code,
        message: 'Contexto de isolamento de conta não inicializado.',
      });
      return;
    }

    const message =
      err instanceof Error ? err.message : 'Erro interno inesperado no servidor.';

    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message,
    });
  });

  return app;
}
