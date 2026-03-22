FROM node:20-alpine AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# ── Build ─────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Production ────────────────────────────────────
FROM base AS production
RUN apk add --no-cache git
ENV NODE_ENV=production
ENV PORT=5000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle.config.ts ./
COPY shared/ ./shared/
COPY migrations/ ./migrations/

EXPOSE 5000

ARG BUILD_DATE=dev
ARG GIT_COMMIT=dev
ENV BUILD_DATE=$BUILD_DATE
ENV GIT_COMMIT=$GIT_COMMIT

CMD ["node", "dist/index.cjs"]
