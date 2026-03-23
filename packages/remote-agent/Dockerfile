FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

FROM base AS build
COPY package.json tsconfig.json ./
COPY src/ src/
RUN npm install && npm run build

FROM base AS production
ENV NODE_ENV=production
# Install CLI tools needed by agents
RUN apk add --no-cache curl && \
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl && \
    curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sh && \
    apk del curl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV AGENT_TYPE=k8s AGENT_PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
