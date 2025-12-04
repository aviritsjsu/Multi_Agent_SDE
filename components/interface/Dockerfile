FROM node:lts-slim AS base
WORKDIR /usr/local/app

##################################################
#                 CLIENT STAGES                  #
##################################################
FROM base AS client-base
COPY client/package* ./ 
RUN npm install
COPY client/eslint.config.js client/index.html client/vite.config.js ./ 
COPY client/public ./public
COPY client/src ./src

FROM client-base AS client-dev
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

FROM client-base AS client-build
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_WORKSPACE_URL
ARG VITE_INTERFACE_API_URL
RUN npm run build

FROM nginx:alpine AS client-prod
COPY --from=client-build /usr/local/app/dist /usr/share/nginx/html
COPY client/nginx.conf.template /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

##################################################
#                 API STAGES                     #
##################################################

# -----------------------------------------------
# ✅ Development server with ADK support
# -----------------------------------------------
FROM base AS server-dev

# Copy package files
COPY api/package* ./ 
ENV NODE_ENV=development

# Install system build deps required by node-gyp and better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 python3-pip build-essential make g++ pkg-config git libsqlite3-dev && \
    ln -sf /usr/bin/python3 /usr/bin/python

# Make Python discoverable for node-gyp on npm 11+
ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3
# Optional: ensure native compile when no prebuilds are available (Node 24/arm64)
ENV npm_config_build_from_source=true

# Install Node dependencies after system deps are present
RUN npm install

# Install Python ADK dependencies
RUN pip install --no-cache-dir --break-system-packages google-adk google-generativeai google-genai mcp

# Copy API source code
COPY api/src ./src

# Default command for development
CMD ["npm", "run", "dev"]

# -----------------------------------------------
# ✅ Production build (with ADK support)
# -----------------------------------------------
FROM base AS server-build

# Copy package files
COPY api/package* ./ 
ENV NODE_ENV=production

# Install system build deps required by node-gyp and better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 python3-pip build-essential make g++ pkg-config git libsqlite3-dev && \
    ln -sf /usr/bin/python3 /usr/bin/python

# Make Python discoverable for node-gyp on npm 11+
ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3
# Optional: ensure native compile when no prebuilds are available (Node 24/arm64)
ENV npm_config_build_from_source=true

# Install Node dependencies after system deps are present
RUN npm ci

# Install Python ADK for production
RUN pip install --no-cache-dir --break-system-packages google-adk google-generativeai google-genai mcp

# Copy API source code and built frontend
COPY api/src ./src
COPY --from=client-build /usr/local/app/dist ./public

#RUN chown -R 1000:1000 /usr/local/app

EXPOSE 3030
# USER 1000

# Start the Node API
CMD ["node", "src/index.js"]
