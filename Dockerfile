ARG BASE=node:20.18.0
FROM ${BASE} AS base

WORKDIR /app

# Install dependencies (this step is cached as long as the dependencies don't change)
COPY package.json pnpm-lock.yaml ./

#RUN npm install -g corepack@latest

#RUN corepack enable pnpm && pnpm install
RUN npm install -g pnpm && pnpm install

# Copy the rest of your app's source code
COPY . .

# Expose the port the app runs on (Cloud Run will override with PORT env var)
EXPOSE 5173

# Production image
FROM base AS bolt-ai-production

# Only set non-sensitive environment variables at build time
ENV WRANGLER_SEND_METRICS=false \
    RUNNING_IN_DOCKER=true \
    VITE_LOG_LEVEL=info

# Pre-configure wrangler to disable metrics
RUN mkdir -p /root/.config/.wrangler && \
    echo '{"enabled":false}' > /root/.config/.wrangler/metrics.json

# Increase Node.js memory limits for build
ENV NODE_OPTIONS="--max_old_space_size=16384"
ENV NPM_CONFIG_MAXSOCKETS=50
ENV NPM_CONFIG_NETWORK_TIMEOUT=300000

# Run build with memory optimizations and caching
RUN --mount=type=cache,target=/root/.pnpm-store \
    --mount=type=cache,target=/app/.cache \
    NODE_OPTIONS="--max_old_space_size=16384 --max-semi-space-size=128" \
    pnpm config set store-dir /root/.pnpm-store && \
    pnpm run build

CMD [ "pnpm", "run", "dockerstart"]

# Development image
FROM base AS bolt-ai-development

# Only set non-sensitive environment variables at build time
ENV RUNNING_IN_DOCKER=true \
    VITE_LOG_LEVEL=debug

RUN mkdir -p ${WORKDIR}/run
CMD pnpm run dev --host
