# Node 20 LTS (also runs on 22). Plain JavaScript — no build step, no ts-node.
FROM node:20-slim

WORKDIR /app

# Dependencies first for layer caching; lockfile keeps it reproducible (npm ci)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Sources. Secrets (.env) and local config are deliberately NOT baked in —
# see .dockerignore and the README Deployment section.
COPY . .

ENV NODE_ENV=production

# index.js runs the gateway in the foreground as PID 1 (exec form, no shell),
# so `docker stop` SIGTERM triggers graceful shutdown + lock cleanup.
CMD ["node", "index.js"]
