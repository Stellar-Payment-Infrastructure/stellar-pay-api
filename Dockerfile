# API image. Build from this repository's root (the pnpm workspace root):
#   docker build -t stellar-pay-api .
# Configuration comes from environment variables (see .env.example).

FROM node:26-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY sdk/package.json sdk/
RUN pnpm install --frozen-lockfile --filter stellar-pay-api
COPY . .
RUN pnpm run build

FROM node:26-alpine AS prod-deps
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY sdk/package.json sdk/
RUN pnpm install --frozen-lockfile --prod --filter stellar-pay-api

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Migrations run on start (MIGRATE_ON_START=true) from ./drizzle.
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
