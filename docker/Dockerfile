# spec-runner candidate environment
#
# Base: mcr.microsoft.com/playwright:v1.49.0-noble
# Includes: Node.js 20, Chromium, Firefox, WebKit, all browser system deps.
#
# The container runs as a long-lived sandbox — commands are injected via
# `docker exec`. The workspace is bind-mounted at /workspace.
#
# Build: bash docker/build.sh
# Image: spec-runner-env:latest

FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Install TypeScript tooling that candidate build steps commonly need
RUN npm install -g typescript@5 ts-node nodemon

# Install the Claude Code CLI — used by agents to generate implementations
# Credentials are supplied at runtime via ~/.claude bind-mount (no API key needed)
RUN npm install -g @anthropic-ai/claude-code

# Default working directory — overridden at exec time with -w flag
WORKDIR /workspace

# Keep the container alive; work arrives via `docker exec`
CMD ["sleep", "infinity"]
