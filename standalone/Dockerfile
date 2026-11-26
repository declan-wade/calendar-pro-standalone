# Build from the repository root, since the card itself is built from there:
#   docker build -f standalone/Dockerfile -t calendar-pro-standalone .

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The card bundle, unchanged from upstream, into /repo/dist.
RUN npm run build
WORKDIR /repo/standalone
RUN npm ci && npm run build:web && npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY standalone/package.json standalone/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /repo/standalone/server/dist ./server/dist
COPY --from=build /repo/standalone/web/dist ./web/dist
ENV CONFIG=/config/config.yaml
EXPOSE 8080
USER node
CMD ["node", "server/dist/server.js"]
