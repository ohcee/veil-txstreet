# VeilStreet — zero-dependency Node app. Works on any container host.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js index.html config.example.json ./

# Default to the mock feed so a fresh deploy is instantly alive with no node.
# To use a real Veil node, set FEED=rpc and the VEIL_RPC_* vars at runtime.
ENV PORT=8790 FEED=mock

EXPOSE 8790
CMD ["node", "server.js"]
