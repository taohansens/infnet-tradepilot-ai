import { Router } from 'express';
import {
  OnboardingService,
  onboardingService as defaultOnboardingService,
} from '../services/onboardingService.js';

/**
 * Rotas HTTP do Onboarding Guiado Invertido (`SPEC-05`, `ADR-04`).
 * Todas as rotas devem ser montadas atrás de `authRlsMiddleware`.
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-11
 * @rnf RNF-25
 */
export function createOnboardingRouter(
  service: OnboardingService = defaultOnboardingService,
): Router {
  const router = Router();

  /**
   * GET /api/v1/onboarding/status
   * @spec SPEC-05
   */
  router.get('/status', async (_req, res, next) => {
    try {
      const status = await service.getStatus();
      res.status(200).json(status);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/v1/onboarding/demo-seed -> 201 Created
   * Popula 45 trades sintéticos marcados com is_demo = true.
   * @spec SPEC-05
   * @rf RF-T-3
   * @rnf RNF-25
   */
  router.post('/demo-seed', async (_req, res, next) => {
    try {
      const result = await service.seedDemoData();
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/v1/onboarding/demo-seed -> 200 OK
   * Limpa em 1 clique todos os trades demonstrativos (is_demo = true).
   * @spec SPEC-05
   * @rf RF-T-3
   */
  router.delete('/demo-seed', async (_req, res, next) => {
    try {
      const result = await service.clearDemoData();
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/v1/onboarding/complete -> 200 OK
   * Marca onboarding_completed = true após importação real.
   * @spec SPEC-05
   * @rf RF-T-3
   */
  router.post('/complete', async (_req, res, next) => {
    try {
      const result = await service.completeOnboarding();
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
