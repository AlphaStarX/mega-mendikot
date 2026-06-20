# Mega Mindikot 5v5 — container image.
#
# The game server itself is hand-rolled (custom WebSocket server over node:http,
# no framework); auth crypto is zero-dependency (scrypt + HS256 via node:crypto).
# Postgres is the ONE intentional runtime dependency. The image therefore runs a
# real `npm ci` (for @prisma/client + pg) and generates the Prisma client.
#
# Usage:
#   docker build -t mega-mindikot .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e JWT_SECRET=... mega-mindikot

FROM node:20-alpine

# openssl is needed by the Prisma query engine on alpine.
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Install deps + generate the Prisma client BEFORE copying source (layer cache).
# Copy only what the install/generate needs.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

# Copy the app source: server + shared modules + the static client.
COPY server/ ./server/
COPY shared/ ./shared/
COPY client/ ./client/

EXPOSE 3000

# Drop to the built-in non-root user. node_modules/.prisma is owned by root from
# the RUN above, but it only needs to be READ by the node user at runtime (the
# engine cache lands in /home/node/.cache which alpine's node user owns).
USER node

# Apply pending migrations, then start the server. Migrate-deploy is a no-op
# when the schema is already up to date, so this is safe on every boot.
CMD ["sh", "-c", "npx prisma migrate deploy && node server/index.js"]
