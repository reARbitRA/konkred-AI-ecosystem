# Konkred Gateway — Node 20 ESM, zero runtime dependencies.
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Package manifest first for better layer caching (no npm install needed:
# the gateway has no external dependencies).
COPY package.json ./
COPY src/ ./src/
COPY data/ ./data/

# Run as a non-root user.
RUN addgroup -S konkred && adduser -S konkred -G konkred \
    && chown -R konkred:konkred /app
USER konkred

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
