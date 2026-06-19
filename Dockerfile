# Mega Mendikot 5v5 — container image.
# The app is zero-dependency (hand-rolled WebSocket server over node:http), so the
# image is tiny: just Node + the source files, no npm install step.
#
# Usage:
#   docker build -t mega-mendikot .
#   docker run -p 3000:3000 -e PORT=3000 mega-mendikot

FROM node:20-alpine

# Run as a non-root user for a slightly smaller attack surface.
WORKDIR /app

# Server reads PORT from env (default 3000) and binds 0.0.0.0.
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy only what the runtime needs: server + shared modules + the static client.
# No package*.json install is performed — there are zero runtime deps.
COPY server/ ./server/
COPY shared/ ./shared/
COPY client/ ./client/
COPY package.json ./package.json

EXPOSE 3000

# node:alpine defaults to root; drop to the built-in 'node' user.
USER node
CMD ["node", "server/index.js"]
