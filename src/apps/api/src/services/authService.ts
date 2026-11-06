import { createHmac, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  MIN_PASSWORD_LENGTH,
  type AuthTokenResponse,
  type LoginRequest,
  type LoginRequires2faResponse,
  type RegisterRequest,
} from '@tradepilot/shared';
import { basePrisma, applyRlsSessionConfig } from '../db/prismaRls.js';

/**
 * Serviço de Cadastro, Autenticação JWT, Refresh Token Rotacionável e 2FA TOTP Opcional.
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-10
 * @rnf RNF-11
 * @rnf RNF-12
 */

const EMAIL_RFC5322_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const BCRYPT_COST = 12;
const DEFAULT_ACCESS_TTL_SECONDS = 900; // 15 minutos (SPEC-01)
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dias

export class AuthServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AuthServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AuthUserLookup {
  id: string;
  email: string;
  passwordHash: string;
  totpEnabled: boolean;
  totpSecret?: string | null;
  planStatus: 'trial' | 'active' | 'past_due' | 'canceled';
  onboardingCompleted: boolean;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserLookup | null>;
  createUserWithRls(input: {
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    lgpdConsentAt: Date;
  }): Promise<AuthUserLookup>;
}

/**
 * Implementação PostgreSQL + Prisma respeitando FORCE ROW LEVEL SECURITY (`RNF-11`).
 * - Login usa a função `SECURITY DEFINER` `auth_find_user_by_email` criada na migration 001.
 * - Cadastro injeta `app.current_user_id` com o UUID pré-gerado antes do INSERT.
 *
 * @spec SPEC-01
 * @rnf RNF-11
 */
export class PrismaAuthRepository implements AuthRepository {
  public async findUserByEmail(email: string): Promise<AuthUserLookup | null> {
    const rows = await basePrisma.$queryRaw<
      Array<{
        id: string;
        email: string;
        password_hash: string;
        totp_enabled: boolean;
        totp_secret_encrypted: string | null;
        plan_status: 'trial' | 'active' | 'past_due' | 'canceled';
        onboarding_completed: boolean;
      }>
    >`SELECT id, email, password_hash, totp_enabled, totp_secret_encrypted, plan_status, onboarding_completed FROM auth_find_user_by_email(${email})`;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      totpEnabled: row.totp_enabled,
      totpSecret: row.totp_secret_encrypted,
      planStatus: row.plan_status,
      onboardingCompleted: row.onboarding_completed,
    };
  }

  public async createUserWithRls(input: {
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    lgpdConsentAt: Date;
  }): Promise<AuthUserLookup> {
    return basePrisma.$transaction(async (tx) => {
      await applyRlsSessionConfig(tx, input.id);
      const created = await tx.user.create({
        data: {
          id: input.id,
          name: input.name,
          email: input.email,
          passwordHash: input.passwordHash,
          lgpdConsentAt: input.lgpdConsentAt,
          onboardingCompleted: false,
          planCode: 'trial',
          planStatus: 'trial',
        },
      });

      return {
        id: created.id,
        email: created.email,
        passwordHash: created.passwordHash,
        totpEnabled: created.totpEnabled,
        planStatus: created.planStatus as AuthUserLookup['planStatus'],
        onboardingCompleted: created.onboardingCompleted,
      };
    });
  }
}

/**
 * Verificação RFC 6238 (TOTP de 6 dígitos, janela ±30s) para 2FA opcional (`SPEC-01`).
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-12
 */
export function verifyTotpCode(
  secretHexOrAscii: string,
  code: string,
  nowMs: number = Date.now(),
): boolean {
  const sanitized = code.trim();
  if (!/^\d{6}$/.test(sanitized)) return false;

  const key = Buffer.from(secretHexOrAscii, 'utf8');
  const currentCounter = Math.floor(nowMs / 1000 / 30);

  for (const offset of [-1, 0, 1]) {
    const counter = currentCounter + offset;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', key).update(buf).digest();
    const dynOffset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const binary =
      (((hmac[dynOffset] ?? 0) & 0x7f) << 24) |
      (((hmac[dynOffset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[dynOffset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[dynOffset + 3] ?? 0) & 0xff);
    const otp = String(binary % 1_000_000).padStart(6, '0');
    if (otp === sanitized) {
      return true;
    }
  }
  return false;
}

export interface AuthServiceOptions {
  repository?: AuthRepository;
  jwtSecret?: string;
  jwtRefreshSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  bcryptCost?: number;
}

/**
 * Serviço principal de autenticação do TradePilot AI (`SPEC-01`).
 *
 * @spec SPEC-01
 * @rf RF-T-1
 * @rnf RNF-11
 * @rnf RNF-12
 */
export class AuthService {
  private readonly repository: AuthRepository;
  private readonly jwtSecretOption?: string;
  private readonly jwtRefreshSecretOption?: string;
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly bcryptCost: number;
  private readonly revokedRefreshJtis = new Set<string>();

  constructor(options: AuthServiceOptions = {}) {
    this.repository = options.repository ?? new PrismaAuthRepository();
    this.jwtSecretOption = options.jwtSecret;
    this.jwtRefreshSecretOption = options.jwtRefreshSecret;
    this.jwtIssuer = options.jwtIssuer ?? process.env.JWT_ISSUER ?? 'tradepilot-ai';
    this.jwtAudience =
      options.jwtAudience ?? process.env.JWT_AUDIENCE ?? 'tradepilot-ai-web';
    this.accessTtlSeconds =
      options.accessTtlSeconds ??
      Number(process.env.JWT_ACCESS_TTL_SECONDS ?? DEFAULT_ACCESS_TTL_SECONDS);
    this.refreshTtlSeconds =
      options.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS;
    this.bcryptCost = options.bcryptCost ?? BCRYPT_COST;
  }

  private getJwtSecret(): string {
    const secret = this.jwtSecretOption ?? process.env.JWT_SECRET;
    if (!secret || secret.length < 16) {
      throw new AuthServiceError(
        500,
        'AUTH_CONFIG_ERROR',
        'Serviço de autenticação temporariamente indisponível.',
      );
    }
    return secret;
  }

  private getJwtRefreshSecret(): string {
    const secret =
      this.jwtRefreshSecretOption ??
      process.env.JWT_REFRESH_SECRET ??
      this.getJwtSecret();
    if (!secret || secret.length < 16) {
      throw new AuthServiceError(
        500,
        'AUTH_CONFIG_ERROR',
        'Serviço de autenticação temporariamente indisponível.',
      );
    }
    return secret;
  }

  private issueTokenPair(user: AuthUserLookup): AuthTokenResponse {
    const accessSecret = this.getJwtSecret();
    const refreshSecret = this.getJwtRefreshSecret();

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        plan_status: user.planStatus,
        token_type: 'access',
      },
      accessSecret,
      {
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
        expiresIn: this.accessTtlSeconds,
      },
    );

    const refreshToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        plan_status: user.planStatus,
        token_type: 'refresh',
        jti: randomUUID(),
      },
      refreshSecret,
      {
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
        expiresIn: this.refreshTtlSeconds,
      },
    );

    return {
      user_id: user.id,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.accessTtlSeconds,
      requires_onboarding: !user.onboardingCompleted,
    };
  }

  /**
   * Cadastra um novo usuário exigindo senha >= 10 caracteres (bcrypt) e `lgpd_consent === true`.
   *
   * @spec SPEC-01
   * @rf RF-T-1
   * @rnf RNF-11
   * @rnf RNF-12
   * @rnf RNF-13
   */
  public async register(input: RegisterRequest): Promise<AuthTokenResponse> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email =
      typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';

    if (name.length < 2) {
      throw new AuthServiceError(
        400,
        'INVALID_NAME',
        'Informe seu nome completo (mínimo 2 caracteres).',
      );
    }

    if (!EMAIL_RFC5322_REGEX.test(email)) {
      throw new AuthServiceError(
        400,
        'INVALID_EMAIL',
        'Informe um endereço de e-mail válido.',
      );
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthServiceError(
        400,
        'WEAK_PASSWORD',
        `A senha deve conter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
    }

    if (input.lgpd_consent !== true) {
      throw new AuthServiceError(
        400,
        'LGPD_CONSENT_REQUIRED',
        'É obrigatório aceitar os termos de privacidade e consentimento LGPD.',
      );
    }

    const existing = await this.repository.findUserByEmail(email);
    if (existing) {
      throw new AuthServiceError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'Este endereço de e-mail já está cadastrado.',
      );
    }

    const passwordHash = await bcrypt.hash(password, this.bcryptCost);
    const created = await this.repository.createUserWithRls({
      id: randomUUID(),
      name,
      email,
      passwordHash,
      lgpdConsentAt: new Date(),
    });

    return this.issueTokenPair(created);
  }

  /**
   * Autentica usuário com senha bcrypt e valida 2FA TOTP quando ativado.
   *
   * @spec SPEC-01
   * @rf RF-T-1
   * @rnf RNF-11
   * @rnf RNF-12
   */
  public async login(
    input: LoginRequest,
  ): Promise<AuthTokenResponse | LoginRequires2faResponse> {
    const email =
      typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';

    if (!email || !password) {
      throw new AuthServiceError(
        400,
        'MISSING_CREDENTIALS',
        'Informe e-mail e senha para entrar.',
      );
    }

    const user = await this.repository.findUserByEmail(email);
    if (!user) {
      throw new AuthServiceError(
        401,
        'INVALID_CREDENTIALS',
        'E-mail ou senha inválidos.',
      );
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new AuthServiceError(
        401,
        'INVALID_CREDENTIALS',
        'E-mail ou senha inválidos.',
      );
    }

    if (user.totpEnabled) {
      if (!input.totp_code) {
        return {
          requires_2fa: true,
          message: 'Informe o código TOTP de 6 dígitos do seu aplicativo autenticador.',
        };
      }
      const totpValid = user.totpSecret
        ? verifyTotpCode(user.totpSecret, input.totp_code)
        : false;
      if (!totpValid) {
        throw new AuthServiceError(
          401,
          'INVALID_TOTP_CODE',
          'Código 2FA (TOTP) inválido ou expirado.',
        );
      }
    }

    return this.issueTokenPair(user);
  }

  /**
   * Rotaciona um refresh token válido e emite um novo par JWT + refresh token.
   *
   * @spec SPEC-01
   * @rf RF-T-1
   * @rnf RNF-12
   */
  public async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    if (!refreshToken) {
      throw new AuthServiceError(
        400,
        'MISSING_REFRESH_TOKEN',
        'Refresh token obrigatório.',
      );
    }

    const secret = this.getJwtRefreshSecret();
    let decoded: jwt.JwtPayload;
    try {
      const verified = jwt.verify(refreshToken, secret, {
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
      });
      if (typeof verified === 'string') {
        throw new Error('Invalid payload');
      }
      decoded = verified;
    } catch {
      throw new AuthServiceError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Refresh token inválido ou expirado.',
      );
    }

    if (decoded.token_type !== 'refresh' || !decoded.sub || !decoded.jti) {
      throw new AuthServiceError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Token fornecido não é um refresh token válido.',
      );
    }

    if (this.revokedRefreshJtis.has(decoded.jti)) {
      throw new AuthServiceError(
        401,
        'REFRESH_TOKEN_REUSED',
        'Refresh token já utilizado. Faça login novamente.',
      );
    }

    this.revokedRefreshJtis.add(decoded.jti);

    return this.issueTokenPair({
      id: decoded.sub,
      email: typeof decoded.email === 'string' ? decoded.email : '',
      passwordHash: '',
      totpEnabled: false,
      planStatus: (decoded.plan_status ?? 'trial') as AuthUserLookup['planStatus'],
      onboardingCompleted: true,
    });
  }
}

export const authService = new AuthService();
