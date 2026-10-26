import { Router } from 'express';
import {
  PrivacyService,
  PrivacyServiceError,
  privacyService as defaultPrivacyService,
} from '../services/privacyService.js';

/**
 * Rotas HTTP de Privacidade e LGPD (Exportação ZIP e Exclusão Definitiva de Conta).
 * Todas as rotas deste router devem ser montadas atrás de `authRlsMiddleware`.
 *
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-4
 * @rnf RNF-11
 * @rnf RNF-13
 * @rnf RNF-30
 */
export function createPrivacyRouter(
  service: PrivacyService = defaultPrivacyService,
): Router {
  const router = Router();

  /**
   * POST /api/v1/privacy/export
   * @spec SPEC-03
   * @rf RF-T-4
   */
  router.post('/export', async (_req, res, next) => {
    try {
      const job = await service.createDataExport();
      res.status(202).json(job);
    } catch (error) {
      if (error instanceof PrivacyServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  /**
   * GET /api/v1/privacy/export/:jobId/download
   * @spec SPEC-03
   * @rf RF-T-4
   */
  router.get('/export/:jobId/download', (req, res, next) => {
    try {
      const { buffer, fileName } = service.getExportDownload(req.params.jobId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(buffer);
    } catch (error) {
      if (error instanceof PrivacyServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  /**
   * DELETE /api/v1/privacy/account
   * @spec SPEC-03
   * @spec SPEC-04
   * @rf RF-T-4
   * @rnf RNF-13
   * @rnf RNF-30
   */
  router.delete('/account', async (req, res, next) => {
    try {
      const result = await service.deleteAccount(req.body ?? {});
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof PrivacyServiceError) {
        res.status(error.statusCode).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  });

  return router;
}
