package main

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jakerobb/restock-radar/internal/api"
	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/dbcopy"
	"github.com/jakerobb/restock-radar/internal/notify"
	"github.com/jakerobb/restock-radar/internal/poller"
	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
	"github.com/jakerobb/restock-radar/internal/util"
)

func main() {
	logLevel := slog.LevelInfo
	if strings.ToLower(os.Getenv("LOG_LEVEL")) == "debug" {
		logLevel = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: logLevel,
	})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "err", err)
		os.Exit(1)
	}

	slog.Info("configuration loaded",
		"poll_interval", cfg.PollInterval,
		"poll_jitter", cfg.PollJitter,
		"http_port", cfg.HTTPPort,
		"db_path", cfg.DBPath,
		"ntfy_url", redactURL(cfg.Ntfy.URL),
		"ntfy_topic", cfg.Ntfy.Topic,
		"regions", len(cfg.Regions),
		"items", len(cfg.Items),
		"max_items", cfg.MaxItems,
		"backup_dir", cfg.BackupDir,
	)

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		slog.Error("failed to open database", "err", err)
		os.Exit(1)
	}
	defer util.CloseCleanly(st)

	keys := make([]store.ItemKey, len(cfg.Items))
	for i, it := range cfg.Items {
		keys[i] = store.ItemKey{Region: it.Region, Slug: it.Slug}
	}
	added, removed, err := st.SyncConfigItems(context.Background(), keys, time.Now())
	if err != nil {
		slog.Error("failed to sync watch list from config", "err", err)
		os.Exit(1)
	}
	slog.Info("watch list synced from config", "added", added, "removed", removed)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	p := poller.New(cfg,
		unistore.New(cfg.UserAgent),
		st,
		notify.NewNtfy(cfg.Ntfy.URL, cfg.Ntfy.Topic, cfg.Ntfy.Token),
	)
	go p.Run(ctx)

	if cfg.BackupDir != "" {
		go dbcopy.Run(ctx, st, cfg.BackupDir, cfg.BackupInterval, cfg.BackupKeep, p.Metrics())
	}

	srv := api.New(st, p, cfg)
	slog.Info("HTTP server starting", "port", cfg.HTTPPort)
	if err := srv.Serve(ctx); err != nil {
		slog.Error("HTTP server failed", "err", err)
		stop()
		util.CloseCleanly(st)
		os.Exit(1)
	}
	slog.Info("shut down")
}

// redactURL hides any password embedded in a URL so it can be logged.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(unparseable URL)"
	}
	return u.Redacted()
}
