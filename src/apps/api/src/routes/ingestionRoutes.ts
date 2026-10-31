import { Router } from 'express';
import multer from 'multer';
import {
  IngestionService,
  IngestionServiceError,
  ingestionService as defaultIngestionService,
} from '../services/ingestionService.js';

/**
 * Rotas HTTP de Ingestão Assíncrona e Conciliação Assistida (`SPEC-06`, `SPEC-08`, `SPEC-09`).
 * Todas as rotas devem ser montadas atrás de `authRlsMiddleware`.
 *
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rnf RNF-3
 * @rnf RNF-9
 * @rnf RNF-11
 * @rnf RNF-30
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB (suporta > 20.000 linhas CSV/XLSX, RNF-3)
  },
});

export function createIngestionRouter(
  service: IngestionService = defaultIngestionService,
): Router {
  const router = Router();

  /**
   * POST /api/v1/ingestion/jobs (multipart/form-data: file, source_hint) -> 202 Accepted
   * @spec SPEC-06
   * @rf RF-M1-5
   * @rnf RNF-3
   */
  router.post('/jobs', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({
          error: 'FILE_REQUIRED',
          message:
            'Selecione um arquivo CSV ou XLSX do Extrato B3 ou das Ordens do Profit.',
        });
        return;
      }

      const sourceHint =
        typeof req.body?.source_hint === 'string'
          ? req.body.source_hint
          : 'B3_CSV';

      const result = await service.enqueueIngestionJob({
        fileBuffer: req.file.buffer,
        fileName: req.file.originalname,
        sourceHint,
      });

      res.status(202).json(result);
    } catch (error) {
      if (error instanceof IngestionServiceError) {
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
   * GET /api/v1/ingestion/jobs/:jobId -> Status, progresso e itens em staging/conflitos
   * @spec SPEC-06
   * @spec SPEC-08
   * @spec SPEC-09
   */
  router.get('/jobs/:jobId', async (req, res, next) => {
    try {
      const detail = await service.getJobDetail(req.params.jobId);
      res.status(200).json(detail);
    } catch (error) {
      if (error instanceof IngestionServiceError) {
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
   * POST /api/v1/ingestion/jobs/:jobId/commit -> Transação atômica única + audit_logs
   * @spec SPEC-09
   * @spec SPEC-04
   * @rf RF-M1-6
   * @rf RF-M1-7
   * @rnf RNF-9
   * @rnf RNF-30
   */
  router.post('/jobs/:jobId/commit', async (req, res, next) => {
    try {
      const committed = await service.commitJob(
        req.params.jobId,
        req.body ?? { resolutions: [] },
      );
      res.status(200).json(committed);
    } catch (error) {
      if (error instanceof IngestionServiceError) {
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
