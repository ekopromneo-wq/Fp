# Multi-stage: `dev` runs the Vite dev server (used by docker-compose.yml,
# which bind-mounts ./frontend for hot reload); `prod` serves a real
# `vite build` output (used by docker-compose.client.yml - the laptop
# "production" frontend). VITE_* values are baked in at build time - that's
# how Vite works - so the prod stage takes them as build args, not runtime env.
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

FROM base AS dev
EXPOSE 4173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

FROM base AS prod
ARG VITE_API_BASE_URL
ARG VITE_DEMO_EMAIL
ARG VITE_DEMO_PASSWORD
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_DEMO_EMAIL=$VITE_DEMO_EMAIL \
    VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD
RUN npm run build
EXPOSE 4173
# `vite preview` is a plain static file server over dist/ - no HMR, no
# transform pipeline, no source mounts. Enough for a single-user laptop
# deployment without pulling in nginx.
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
