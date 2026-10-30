# The Worker for the local demo stack: `wrangler dev` with local D1 and Durable Objects. Not used for the Cloudflare deployment.
FROM node:22-bookworm-slim
# workerd refuses to start without a system CA bundle, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false CI=true NO_UPDATE_NOTIFIER=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENTRYPOINT ["sh", "docker/worker-entrypoint.sh"]
