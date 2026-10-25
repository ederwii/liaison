#!/bin/bash
# Runs the whole test suite (tests/run) on Linux, in a throwaway Ubuntu 24.04 container. Needs Docker.
# Usage: scripts/linux-test.sh      exit 0 only when tests/run passed inside the container.
cd "$(dirname "$0")/.." || exit 2
if ! command -v docker >/dev/null 2>&1; then
  echo "linux-test: docker is not installed or not on PATH; install Docker to run the Linux check" >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "linux-test: the Docker daemon is not running; start Docker and try again" >&2
  exit 2
fi
# The container starts as root only to install packages, then drops to your uid:gid (setpriv) for bun and the tests, so
# nothing root-owned lands in the checkout. bun installs under HOME=/tmp/home inside the container.
exec docker run --rm -v "$PWD":/src -w /src -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq curl git python3 unzip jq >/dev/null &&
  mkdir -p /tmp/home && chown "$HOST_UID:$HOST_GID" /tmp/home &&
  exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups env HOME=/tmp/home \
    bash -c "curl -fsSL https://bun.sh/install | bash && export PATH=\$HOME/.bun/bin:\$PATH && tests/run"'
