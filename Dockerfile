
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DB_FILE=/data/dompet.db

COPY . .

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8080

CMD ["node", "server.js"]
