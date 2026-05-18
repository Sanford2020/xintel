FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/
COPY config/ config/

RUN npm run build

FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ dist/
COPY config/ config/

RUN mkdir -p data/runs data/summaries data/logs data/aggregates data/dashboard

ENV NODE_ENV=production
ENV XINTEL_API_PORT=3000
ENV XINTEL_API_HOST=0.0.0.0

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/cli/index.js", "api", "--port", "3000", "--host", "0.0.0.0"]
