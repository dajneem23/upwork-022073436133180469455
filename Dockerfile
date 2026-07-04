# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Production stage ───────────────────────────────────────────────────────────
FROM node:22-alpine

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy only production deps from builder
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules

# Copy app source
COPY --chown=appuser:appgroup public/ ./public/
COPY --chown=appuser:appgroup server.js ./

# Switch to non-root user
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
