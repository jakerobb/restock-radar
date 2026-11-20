package dbquery

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/store"
)

// testDB makes a real, migrated database holding a few rows.
func testDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`CREATE TABLE scratch (a INTEGER, b TEXT, c BLOB)`,
		`INSERT INTO scratch VALUES (1, 'one', x'6869'), (2, NULL, NULL), (3, 'tab' || char(9) || 'nl' || char(10), NULL)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func run(t *testing.T, path, q string, f Format, limit int) (string, bool, error) {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var buf bytes.Buffer
	trunc, err := Run(context.Background(), db, q, &buf, f, limit)
	return buf.String(), trunc, err
}

func TestTSV(t *testing.T) {
	got, trunc, err := run(t, testDB(t), `SELECT a, b, c FROM scratch ORDER BY a`, TSV, 0)
	if err != nil || trunc {
		t.Fatalf("err=%v truncated=%v", err, trunc)
	}
	want := "a\tb\tc\n1\tone\thi\n2\tNULL\tNULL\n3\ttab\\tnl\\n\tNULL\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestJSON(t *testing.T) {
	got, _, err := run(t, testDB(t), `SELECT a, b FROM scratch WHERE a < 3 ORDER BY a`, JSON, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := "[\n{\"a\":1,\"b\":\"one\"},\n{\"a\":2,\"b\":null}\n]\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestJSONNoRows(t *testing.T) {
	got, _, err := run(t, testDB(t), `SELECT a FROM scratch WHERE a > 99`, JSON, 0)
	if err != nil || strings.TrimSpace(got) != "[\n]" {
		t.Errorf("got %q, err %v", got, err)
	}
}

func TestLimit(t *testing.T) {
	got, trunc, err := run(t, testDB(t), `SELECT a FROM scratch ORDER BY a`, TSV, 2)
	if err != nil || !trunc {
		t.Fatalf("err=%v truncated=%v", err, trunc)
	}
	if got != "a\n1\n2\n" {
		t.Errorf("got %q", got)
	}
}

func TestRefusesWrites(t *testing.T) {
	path := testDB(t)
	for _, q := range []string{
		`DELETE FROM scratch`,
		`INSERT INTO scratch VALUES (9, 'x', NULL)`,
		`DROP TABLE scratch`,
		`CREATE TABLE other (x)`,
		`UPDATE scratch SET a = 0`,
	} {
		if _, _, err := run(t, path, q, TSV, 0); err == nil {
			t.Errorf("%q was allowed", q)
		}
	}
	got, _, err := run(t, path, `SELECT count(*) FROM scratch`, TSV, 0)
	if err != nil || got != "count(*)\n3\n" {
		t.Errorf("table changed: %q, %v", got, err)
	}
}

func TestSchema(t *testing.T) {
	got, _, err := run(t, testDB(t), SchemaQuery, TSV, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"table\tproducts\t", "table\tevents\t", "table\tscratch\t"} {
		if !strings.Contains(got, want) {
			t.Errorf("schema missing %q", want)
		}
	}
}

// The service keeps the database open and writing while we read it.
func TestReadsWhileStoreIsOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	got, _, err := run(t, path, `SELECT count(*) AS n FROM products`, TSV, 0)
	if err != nil || got != "n\n0\n" {
		t.Errorf("got %q, err %v", got, err)
	}
}

func TestBadSQL(t *testing.T) {
	if _, _, err := run(t, testDB(t), `SELEKT 1`, TSV, 0); err == nil {
		t.Error("bad SQL accepted")
	}
}

func TestOpenMissingFile(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "nope.db")); err == nil {
		t.Error("a missing database was opened (and so would have been created)")
	}
}
