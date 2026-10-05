package dbcopy

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jakerobb/restock-radar/internal/store"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

func TestOnceWritesAConsistentCopyAndPrunes(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	if _, err := st.AddItem(ctx, "us", "ui-added", store.SourceUI, "", now); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Apply(ctx, "us", &unistore.Product{ID: "p1", Slug: "w", Title: "W", Variants: []unistore.Variant{
		{ID: "v1", SKU: "W-1", Title: "US", Status: "Available", Price: &unistore.Money{Amount: 100, Currency: "USD"}}}}, now); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	for i := 0; i < 5; i++ {
		if _, err := Once(ctx, st, dir, 3, now.Add(time.Duration(i)*24*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	names, _ := list(dir)
	if len(names) != 3 || names[0] != "restock-radar-20261007-120000.db" || names[2] != "restock-radar-20261009-120000.db" {
		t.Fatalf("want the newest 3 kept, got %v", names)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 3 {
		t.Fatalf("no temp files should be left behind: %v", entries)
	}

	// The copy opens as a normal database holding the same data, UI-added item included.
	latest, err := Latest(dir)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(latest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restored.Close() }()
	items, _ := restored.Items(ctx)
	vs, _ := restored.Variants(ctx, "us")
	if len(items) != 1 || items[0].Source != store.SourceUI || len(vs) != 1 || vs[0].SKU != "W-1" {
		t.Fatalf("restored database is missing data: items=%+v variants=%+v", items, vs)
	}

	// And it passes SQLite's own integrity check.
	raw, err := sql.Open("sqlite", latest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = raw.Close() }()
	var res string
	if err := raw.QueryRow(`PRAGMA integrity_check`).Scan(&res); err != nil || res != "ok" {
		t.Fatalf("integrity_check = %q, %v", res, err)
	}
}

func TestOnceFailureLeavesNoPartialFile(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	dir := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := Once(context.Background(), st, dir, 3, time.Now()); err == nil {
		t.Fatal("backing up into a missing directory should fail")
	}
}

func TestNewestAndLatestWithNoBackups(t *testing.T) {
	dir := t.TempDir()
	if _, ok := newest(dir); ok {
		t.Error("an empty directory has no newest backup")
	}
	if _, err := Latest(dir); err == nil {
		t.Error("Latest should error when there are no backups")
	}
	_ = os.WriteFile(filepath.Join(dir, "unrelated.txt"), []byte("x"), 0o600)
	if names, _ := list(dir); len(names) != 0 {
		t.Errorf("unrelated files must be ignored: %v", names)
	}
}
