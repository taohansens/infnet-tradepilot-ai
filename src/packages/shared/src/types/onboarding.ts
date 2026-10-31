/**
 * Contratos de dados do Onboarding Guiado Invertido ("Value First" + Base Demonstrativa).
 *
 * @spec SPEC-05
 * @rf RF-T-3
 * @rnf RNF-25
 */

export interface DemoSeedResponse {
  seeded_trades: number;
  is_demo: true;
  redirect_to: '/dashboard';
}

export interface ClearDemoSeedResponse {
  removed_demo_trades: number;
  message: string;
}

export interface CompleteOnboardingResponse {
  onboarding_completed: true;
  redirect_to: '/dashboard';
}

export interface OnboardingStatusResponse {
  onboarding_completed: boolean;
  has_demo_trades: boolean;
  demo_trades_count: number;
  real_trades_count: number;
}
