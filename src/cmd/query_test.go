package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jakerobb/restock-radar/internal/store"
)

func newDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	return path
}

func query(t *testing.T, stdin string, args ...string) (code int, out, errOut string) {
	t.Helper()
	var o, e bytes.Buffer
	code = runQuery(args, strings.NewReader(stdin), &o, &e)
	return code, o.String(), e.String()
}

func TestRunQuery(t *testing.T) {
	db := newDB(t)

	code, out, _ := query(t, "", "--db", db, "SELECT", "1", "AS", "x")
	if code != 0 || out != "x\n1\n" {
		t.Errorf("joined args: code %d, out %q", code, out)
	}
	code, out, _ = query(t, "SELECT 2 AS y", "--db", db, "-")
	if code != 0 || out != "y\n2\n" {
		t.Errorf("stdin: code %d, out %q", code, out)
	}
	code, out, _ = query(t, "", "--db", db, "--json", "SELECT 3 AS z")
	if code != 0 || !strings.Contains(out, `{"z":3}`) {
		t.Errorf("json: code %d, out %q", code, out)
	}
	code, out, _ = query(t, "", "--db", db, "--schema")
	if code != 0 || !strings.Contains(out, "table\tevents\t") {
		t.Errorf("schema: code %d, out %q", code, out)
	}
}

func TestRunQueryFailures(t *testing.T) {
	db := newDB(t)
	for name, args := range map[string][]string{
		"no statement":     {"--db", db},
		"schema+statement": {"--db", db, "--schema", "SELECT 1"},
		"write":            {"--db", db, "DELETE FROM products"},
		"bad sql":          {"--db", db, "SELEKT"},
		"no such db":       {"--db", filepath.Join(t.TempDir(), "x.db"), "SELECT 1"},
		"bad flag":         {"--nope"},
	} {
		if code, _, _ := query(t, "", args...); code == 0 {
			t.Errorf("%s: exited 0", name)
		}
	}
}

func TestRunQueryTruncationNotice(t *testing.T) {
	code, _, errOut := query(t, "", "--db", newDB(t), "--limit", "1", "SELECT 1 UNION SELECT 2")
	if code != 0 || !strings.Contains(errOut, "stopped at 1 rows") {
		t.Errorf("code %d, stderr %q", code, errOut)
	}
}
