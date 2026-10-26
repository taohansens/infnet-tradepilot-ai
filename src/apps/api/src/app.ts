import express, { type NextFunction, type Request, type Response } from 'express';
import { authRlsMiddleware } from './middlewares/authRls.js';
import { auditService } from './services/auditService.js';
import { RlsContextError } from './db/rlsContext.js';

/**
 * Aplicação Express do backend TradePilot AI.
 *
 * @spec SPEC-01
 * @spec SPEC-04
 * @rnf RNF-11
 * @rnf RNF-30
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'tradepilot-api',
      timestamp_utc: new Date().toISOString(),
    });
  });

  /**
   * Consulta da trilha de auditoria imutável do usuário autenticado.
   *
   * @spec SPEC-04
   * @rnf RNF-11
   * @rnf RNF-30
   */
  app.get('/api/v1/audit-logs', authRlsMiddleware, async (req, res, next) => {
    try {
      const limitParam = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitParam) ? limitParam : 50;
      const logs = await auditService.listAuditEvents({ limit });
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
