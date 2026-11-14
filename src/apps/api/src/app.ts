import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, type AuditAction, type AuditEntityType } from '@tradepilot/shared';
import { authRlsMiddleware } from './middlewares/authRls.js';
import { auditService } from './services/auditService.js';
import { RlsContextError } from './db/rlsContext.js';
import { createAnalyticsRouter } from './routes/analyticsRoutes.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createIngestionRouter } from './routes/ingestionRoutes.js';
import { createInstrumentRouter } from './routes/instrumentRoutes.js';
import { createOnboardingRouter } from './routes/onboardingRoutes.js';
import { createPrivacyRouter } from './routes/privacyRoutes.js';
import { createTradesRouter } from './routes/tradesRoutes.js';

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

  // Rotas autenticadas de onboarding invertido e base demonstrativa (SPEC-05)
  app.use('/api/v1/onboarding', authRlsMiddleware, createOnboardingRouter());

  // Rotas autenticadas do Diário de Trade (SPEC-10, SPEC-12, SPEC-13)
  app.use('/api/v1/trades', authRlsMiddleware, createTradesRouter());

  // Rotas autenticadas de Analytics determinístico e Raio-X (SPEC-14 a SPEC-17, SPEC-20)
  app.use('/api/v1/analytics', authRlsMiddleware, createAnalyticsRouter());

  // Rotas autenticadas de configuração de instrumentos e custos B3 (Taometria / SPEC-06)
  app.use('/api/v1/instruments', authRlsMiddleware, createInstrumentRouter());

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

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RlsContextError) {
      res.status(401).json({
        error: err.code,
        message: 'Sessão expirada ou não autenticada. Faça login novamente.',
      });
      return;
    }

    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'O arquivo enviado excede o limite máximo permitido de 15 MB.'
          : 'Não foi possível receber o arquivo enviado. Verifique o formato e tente novamente.';
      res.status(status).json({
        error: 'UPLOAD_ERROR',
        message,
      });
      return;
    }

    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: 'INVALID_JSON_PAYLOAD',
        message: 'Os dados enviados estão em formato inválido.',
      });
      return;
    }

    // Log estruturado apenas no servidor — nunca expor err.message/stack trace para a UI
    console.error('[tradepilot-api] Erro interno não tratado', {
      requestId: req.auth?.requestId ?? req.headers['x-request-id'] ?? null,
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });

    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message:
        'Ocorreu um erro interno ao processar sua solicitação. Tente novamente em instantes.',
    });
  });

  return app;
}
