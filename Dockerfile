FROM node:20-alpine
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories
RUN apk add --no-cache openssl python3
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js danmaku.js gen_authx.py ./
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
