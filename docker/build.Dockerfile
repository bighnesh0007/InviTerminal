# syntax=docker/dockerfile:1
# Builds the Linux packages (AppImage + unpacked dir) without Node, Python or a C++ toolchain on
# the host. Output lands in ./release:
#
#   docker build -f docker/build.Dockerfile --target out -o release .
#
# The image runs the typecheck and the test suite first, so a broken build never produces a package.
# (Tests that need hardware or a system mongod skip themselves visibly.)

FROM node:22-bookworm AS build
# node-pty compiles from source on Linux; electron-builder needs nothing else to build an AppImage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Dependencies first, so source edits don't re-download them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npx vitest run
RUN npm run build && npx electron-builder --linux AppImage dir --publish never

FROM scratch AS out
COPY --from=build /src/release/ /
