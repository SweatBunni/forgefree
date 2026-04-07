FROM eclipse-temurin:21-jdk-jammy

ENV NODE_ENV=production
WORKDIR /app

ARG NODE_VERSION=20.19.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) node_arch='x64' ;; \
       arm64) node_arch='arm64' ;; \
       *) echo "Unsupported architecture: $arch" && exit 1 ;; \
     esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
     | tar -xJ --strip-components=1 -C /usr/local \
  && node --version \
  && npm --version \
  && java -version

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "backend.js"]
