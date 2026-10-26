/**
 * Contratos de dados de Autenticação (SPEC-01) e Privacidade/LGPD (SPEC-03).
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @rf RF-T-1
 * @rf RF-T-4
 * @rnf RNF-12
 * @rnf RNF-13
 */

export const ACCOUNT_DELETE_CONFIRMATION_PHRASE = 'EXCLUIR MINHA CONTA' as const;

export const MIN_PASSWORD_LENGTH = 10 as const;

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
  lgpd_consent: boolean;
}

export interface AuthTokenResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  requires_onboarding: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
  totp_code?: string;
}

export interface LoginRequires2faResponse {
  requires_2fa: true;
  message: string;
}

export interface PrivacyExportJobResponse {
  job_id: string;
  status: 'processing' | 'ready' | 'failed';
  estimated_seconds: number;
  download_url?: string;
  created_at_utc?: string;
}

export interface DeleteAccountRequest {
  confirmation_phrase: string;
  password: string;
}

export interface DeleteAccountResponse {
  deleted: true;
  audit_id: string;
  message: string;
}
