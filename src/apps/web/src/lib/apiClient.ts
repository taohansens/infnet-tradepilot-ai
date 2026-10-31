import type {
  AuthTokenResponse,
  CommitIngestionJobRequest,
  CommitIngestionJobResponse,
  CreateIngestionJobResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  IngestionJobDetailResponse,
  LoginRequest,
  LoginRequires2faResponse,
  PrivacyExportJobResponse,
  RegisterRequest,
  UploadSourceHint,
} from '@tradepilot/shared';

/**
 * Cliente HTTP tipado para comunicação do Frontend Next.js com a API TradePilot AI.
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @rf RF-T-1
 * @rf RF-T-4
 * @rnf RNF-10
 * @rnf RNF-11
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

const ACCESS_TOKEN_KEY = 'tradepilot_access_token';
const REFRESH_TOKEN_KEY = 'tradepilot_refresh_token';

export interface ApiErrorPayload {
  error?: string;
  message?: string;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

export function saveAuthTokens(tokens: Pick<AuthTokenResponse, 'access_token' | 'refresh_token'>): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(ACCESS_TOKEN_KEY, tokens.access_token);
  window.sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearAuthTokens(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  window.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  authenticated = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  if (authenticated) {
    const token = getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload & T;

  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload.error ?? 'API_ERROR',
      payload.message ?? 'Não foi possível concluir a solicitação. Tente novamente.',
    );
  }

  return payload;
}

export function registerAccount(data: RegisterRequest): Promise<AuthTokenResponse> {
  return requestJson<AuthTokenResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function loginAccount(
  data: LoginRequest,
): Promise<AuthTokenResponse | LoginRequires2faResponse> {
  return requestJson<AuthTokenResponse | LoginRequires2faResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function requestPrivacyExport(): Promise<PrivacyExportJobResponse> {
  return requestJson<PrivacyExportJobResponse>(
    '/privacy/export',
    { method: 'POST' },
    true,
  );
}

export async function downloadPrivacyExportZip(downloadUrl: string): Promise<Blob> {
  const token = getAccessToken();
  const fullUrl = downloadUrl.startsWith('http')
    ? downloadUrl
    : `${API_BASE_URL.replace(/\/api\/v1$/, '')}${downloadUrl}`;

  const response = await fetch(fullUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      'DOWNLOAD_FAILED',
      'Não foi possível baixar o arquivo ZIP de exportação.',
    );
  }

  return response.blob();
}

export function deletePrivacyAccount(
  data: DeleteAccountRequest,
): Promise<DeleteAccountResponse> {
  return requestJson<DeleteAccountResponse>(
    '/privacy/account',
    {
      method: 'DELETE',
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface AuditLogListItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  createdAtUtc: string;
}

export function fetchAuditLogs(limit = 30): Promise<{ items: AuditLogListItem[] }> {
  return requestJson<{ items: AuditLogListItem[] }>(
    `/audit-logs?limit=${limit}`,
    { method: 'GET' },
    true,
  );
}

/**
 * Envia arquivo CSV/XLSX para ingestão assíncrona (`POST /api/v1/ingestion/jobs`).
 * @spec SPEC-06
 * @rf RF-M1-5
 */
export async function uploadIngestionFile(
  file: File,
  sourceHint: UploadSourceHint,
): Promise<CreateIngestionJobResponse> {
  const token = getAccessToken();
  const formData = new FormData();
  formData.append('file', file);
  formData.append('source_hint', sourceHint);

  const response = await fetch(`${API_BASE_URL}/ingestion/jobs`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload &
    CreateIngestionJobResponse;

  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload.error ?? 'UPLOAD_FAILED',
      payload.message ?? 'Não foi possível enviar o arquivo para importação.',
    );
  }

  return payload;
}

/**
 * Consulta progresso e itens em staging/conflitos de um job (`GET /api/v1/ingestion/jobs/:jobId`).
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 */
export function fetchIngestionJob(
  jobId: string,
): Promise<IngestionJobDetailResponse> {
  return requestJson<IngestionJobDetailResponse>(
    `/ingestion/jobs/${jobId}`,
    { method: 'GET' },
    true,
  );
}

/**
 * Efetiva o lote em staging aplicando resoluções em transação atômica única (`POST /api/v1/ingestion/jobs/:jobId/commit`).
 * @spec SPEC-09
 * @rf RF-M1-6
 * @rf RF-M1-7
 */
export function commitIngestionJob(
  jobId: string,
  payload: CommitIngestionJobRequest,
): Promise<CommitIngestionJobResponse> {
  return requestJson<CommitIngestionJobResponse>(
    `/ingestion/jobs/${jobId}/commit`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true,
  );
}
