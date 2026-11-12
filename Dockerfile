# Compile the web UI to static files. Runs natively on the build host (the
# output is platform-independent), and the Go build below embeds the result.
# Base images are pinned by digest as well as tag; Renovate bumps both together.
FROM --platform=$BUILDPLATFORM node:26.13.1@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS ui

WORKDIR /ui

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ .
RUN npm run build

# Builder runs natively on the build host and cross-compiles for each target
# platform (no QEMU emulation needed for a CGO-free Go build).
FROM --platform=$BUILDPLATFORM golang:1.27.4@sha256:5e8afd493a7124a8586e134d9b532731161d4b9becf9dee5a5956b107426f93d AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /app

COPY src/go.mod .
COPY src/go.sum .
RUN go mod download

COPY src/ .
COPY --from=ui /ui/dist/ ./internal/webui/dist/

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o restock-radar "./cmd"

FROM scratch

# CA bundle for HTTPS to the UniFi store (and ntfy, if it's behind TLS).
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/restock-radar /restock-radar

# The SQLite database lives here; mount a volume writable by 65532.
USER 65532:65532
WORKDIR /data

EXPOSE 8080

ENTRYPOINT ["/restock-radar"]
