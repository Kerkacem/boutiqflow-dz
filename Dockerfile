# ======================================================================
# MAHAL PRODUCTION DOCKERFILE
# Multi-stage, minimal, non-root user
# ======================================================================

# Stage 1: Build & Dependencies
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./
# In CI/Docker build: install production dependencies
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm lint && pnpm typecheck && pnpm test

# Stage 2: Production Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Create non-root user for security (OWASP ASVS)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mahalapp

COPY --from=builder /app /app

USER mahalapp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/server.js"]
