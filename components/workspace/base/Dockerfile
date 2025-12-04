FROM codercom/code-server:4.104.2

ENV CS_DISABLE_GETTING_STARTED_OVERRIDE=1
ENV PORT=8085
EXPOSE 8085

RUN mkdir -p ~/.docker/cli-plugins && chown -R 1000:1000 ~/.docker
COPY --link --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --link --chown=1000:1000 --from=docker:28.4.0 /usr/local/libexec/docker/cli-plugins /home/coder/.docker/cli-plugins
COPY --link --chown=1000:1000 --from=docker/scout-cli:1.18.4 /docker-scout /home/coder/.docker/cli-plugins/docker-scout
COPY --link --chown=1000:1000 --from=docker/docker-model-cli-desktop-module:v0.1.42 /cli-plugins/model/linux/docker-model /home/coder/.docker/cli-plugins/docker-model
COPY --link --chown=1000:1000 --from=docker/docker-mcp-cli-desktop-module:v0.21.0 /cli-plugins/mcp/linux/docker-mcp /home/coder/.docker/cli-plugins/docker-mcp

USER root

RUN mkdir -p /home/coder/.config/code-server && \
    mkdir -p /home/coder/.local/share/code-server && \
    mkdir -p /home/coder/.npm && \
    chown -R 1000:1000 /home/coder

RUN mkdir -p /home/coder/project && chown -R 1000:1000 /home/coder/project
RUN mkdir -p /tmp/projects && chmod 777 /tmp/projects

RUN apt update && \
    apt install -y jq python3 python3-pip python3.11-venv && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

# Install gcsfuse
RUN export GCSFUSE_REPO=gcsfuse-`lsb_release -c -s` && \
    echo "deb https://packages.cloud.google.com/apt $GCSFUSE_REPO main" | tee /etc/apt/sources.list.d/gcsfuse.list && \
    curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key add - && \
    apt-get update && \
    apt-get install -y gcsfuse && \
    rm -rf /var/lib/apt/lists/*
# nvm installation moved to coder user stage
# nvm install moved to coder user stage

USER 1000
ENV NVM_DIR=/home/coder/.nvm
RUN bash -lc 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install 22 && nvm alias default 22'
RUN echo 'export NVM_DIR="$HOME/.nvm"' >> /home/coder/.bashrc && \
    echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> /home/coder/.bashrc
RUN code-server --install-extension ms-azuretools.vscode-docker && \
    code-server --install-extension github.vscode-github-actions && \
    code-server --install-extension docker.docker && \
    rm -rf /home/coder/.local/share/code-server/CachedExtensionVSIXs/.trash/*

# RUN --mount=from=extension,target=/extension \
#     code-server --install-extension /extension/support-extension.vsix && \
#     rm -rf /home/coder/.local/share/code-server/CachedExtensionVSIXs/.trash/*

COPY --chown=1000:1000 ./config.yaml /home/coder/.config/code-server/config.yaml
COPY --chown=1000:1000 ./settings.json /home/coder/.local/share/code-server/User/settings.json

ENV TESTCONTAINERS_HOST_OVERRIDE=localhost
ENV MODEL_RUNNER_HOST=http://model-runner.docker.internal
ENV LAB_RUNNER_PUBLIC_KEY_PATH=/etc/lab-runner/public-key/runner.pem

EXPOSE 8086

# Start code-server, ensure projects directory exists, and open it
# Start code-server
# Cloud Run will mount the GCS bucket at /home/coder/project
CMD ["code-server", "--auth", "none", "--bind-addr", "0.0.0.0:8085", "/home/coder/project"]