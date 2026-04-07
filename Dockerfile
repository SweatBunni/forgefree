FROM node:20-bookworm-slim AS node-runtime

FROM eclipse-temurin:21-jdk-jammy

ENV NODE_ENV=production
WORKDIR /app

COPY --from=node-runtime /usr/local /usr/local

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "backend.js"]
