FROM node:18-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY greenapi-wrapper.js ./
COPY vault-search.js ./
COPY rate-limiter.js ./

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
