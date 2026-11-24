# ============================================================================
# Dockerfile Multi-Stage — TradePilot AI Backend (Coolify Deploy)
# Build Context: ./src
# Dockerfile Path: apps/api/Dockerfile
#
# @spec SPEC-01
# @rnf RNF-11
# @rnf RNF-21
# ============================================================================

FROM node:20-alpine AS builder

WORKDIR /app

# Instala OpenSSL necessário para o Prisma Query Engine no Alpine
RUN apk add --no-cache openssl

# Copia manifestos do monorepo para aproveitar cache de camadas
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci --workspace=@tradepilot/shared --workspace=@tradepilot/api --include-workspace-root

# Copia código-fonte do shared e da api + schema/migrations Prisma
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Gera Prisma Client e compila shared + api
RUN npm run prisma:generate --workspace=@tradepilot/api \
  && npm run build --workspace=@tradepilot/shared \
  && npm run build --workspace=@tradepilot/api

# ----------------------------------------------------------------------------
# Estágio de Produção (imagem enxuta, usuário não-root)
# ----------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001

RUN apk add --no-cache openssl curl

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

# Aplica migrations Prisma (incluindo RLS e trigger append-only) antes de iniciar a API
CMD ["sh", "-c", "npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma && node apps/api/dist/server.js"]
