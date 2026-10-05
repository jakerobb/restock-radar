# Compile the web UI to static files. Runs natively on the build host (the
# output is platform-independent), and the Go build below embeds the result.
FROM --platform=$BUILDPLATFORM node:24 AS ui

WORKDIR /ui

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ .
RUN npm run build

# Builder runs natively on the build host and cross-compiles for each target
# platform (no QEMU emulation needed for a CGO-free Go build).
FROM --platform=$BUILDPLATFORM golang:1.27.1 AS builder

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
