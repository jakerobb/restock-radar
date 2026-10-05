// Package dbcopy periodically copies the database to a directory (a volume on
// a different machine from the live one), keeping the newest few copies.
package dbcopy

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/metrics"
)

const (
	prefix = "restock-radar-"
	suffix = ".db"
	// retryAfter is how long to wait after a failed attempt, however long
	// the interval is.
	retryAfter = 15 * time.Minute
)

// Source is something that can write a consistent copy of itself to a path.
type Source interface {
	Backup(ctx context.Context, dest string) error
}

// Once writes one backup into dir, then prunes all but the newest keep. It
// returns the new file's path.
func Once(ctx context.Context, src Source, dir string, keep int, now time.Time) (string, error) {
	dest := filepath.Join(dir, prefix+now.UTC().Format("20060102-150405")+suffix)
	if err := src.Backup(ctx, dest); err != nil {
		return "", err
	}
	if err := prune(dir, keep); err != nil {
		// The new backup is safe; failing to tidy old ones shouldn't fail the run.
		slog.Warn("failed to prune old backups", "dir", dir, "err", err)
	}
	return dest, nil
}

// list returns the backup files in dir, oldest first. The names sort by time.
func list(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		n := e.Name()
		if !e.IsDir() && strings.HasPrefix(n, prefix) && strings.HasSuffix(n, suffix) {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, nil
}

func prune(dir string, keep int) error {
	names, err := list(dir)
	if err != nil {
		return err
	}
	for len(names) > keep {
		if err := os.Remove(filepath.Join(dir, names[0])); err != nil {
			return err
		}
		names = names[1:]
	}
	return nil
}

// newest returns the modification time of the most recent backup.
func newest(dir string) (time.Time, bool) {
	names, err := list(dir)
	if err != nil || len(names) == 0 {
		return time.Time{}, false
	}
	info, err := os.Stat(filepath.Join(dir, names[len(names)-1]))
	if err != nil {
		return time.Time{}, false
	}
	return info.ModTime(), true
}

// Run takes a backup every interval until ctx is cancelled. The schedule is
// anchored on the newest existing backup, so restarting the service doesn't
// trigger a fresh one each time (which would also push the older ones out).
func Run(ctx context.Context, src Source, dir string, interval time.Duration, keep int, m *metrics.Metrics) {
	m.EnableBackup(time.Now())
	slog.Info("database backups enabled", "dir", dir, "interval", interval, "keep", keep)

	for {
		wait := time.Duration(0)
		if last, ok := newest(dir); ok {
			wait = max(0, time.Until(last.Add(interval)))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}

		path, err := Once(ctx, src, dir, keep, time.Now())
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			m.Backup(metrics.BackupError, time.Now())
			slog.Error("database backup failed", "dir", dir, "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(min(retryAfter, interval)):
			}
			continue
		}
		m.Backup(metrics.BackupOK, time.Now())
		slog.Info("database backed up", "file", path)
		// Wait the full interval even if the file's mtime is in the past.
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// Latest reports the path of the newest backup in dir, for tooling and tests.
func Latest(dir string) (string, error) {
	names, err := list(dir)
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return "", fmt.Errorf("no backups in %s", dir)
	}
	return filepath.Join(dir, names[len(names)-1]), nil
}
