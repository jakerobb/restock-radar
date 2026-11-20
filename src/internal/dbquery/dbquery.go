// Package dbquery runs ad-hoc read-only SQL against the database, for
// investigating a running deployment: the image has no shell and no sqlite3,
// so `kubectl exec deploy/restock-radar -- /restock-radar query "..."` is the
// way in.
package dbquery

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// SchemaQuery lists every table, index and view with its definition.
const SchemaQuery = `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`

// Format is how rows are written.
type Format string

const (
	TSV  Format = "tsv"
	JSON Format = "json"
)

// Open opens the database at path for reading only. The connection refuses
// every write (query_only), so a mistyped statement can't change anything, and
// it doesn't take the write lock, so the poller carries on while it runs.
func Open(path string) (*sql.DB, error) {
	dsn := "file:" + (&url.URL{Path: path}).EscapedPath() +
		"?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database %s: %w", path, err)
	}
	// One connection: a query is one statement run once.
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("opening database %s: %w", path, err)
	}
	return db, nil
}

// Run executes query and writes up to limit rows to w. It reports whether more
// rows were left. A limit of zero or less means no limit.
func Run(ctx context.Context, db *sql.DB, query string, w io.Writer, format Format, limit int) (truncated bool, err error) {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()

	cols, err := rows.Columns()
	if err != nil {
		return false, err
	}

	var out rowWriter
	switch format {
	case TSV:
		out = &tsvWriter{w: w}
	case JSON:
		out = &jsonWriter{w: w}
	default:
		return false, fmt.Errorf("unknown format %q", format)
	}
	if err := out.start(cols); err != nil {
		return false, err
	}

	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	n := 0
	for rows.Next() {
		if limit > 0 && n >= limit {
			truncated = true
			break
		}
		if err := rows.Scan(ptrs...); err != nil {
			return false, err
		}
		for i, v := range vals {
			if b, ok := v.([]byte); ok {
				vals[i] = string(b)
			}
		}
		if err := out.row(vals); err != nil {
			return false, err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return truncated, out.finish()
}

type rowWriter interface {
	start(cols []string) error
	row(vals []any) error
	finish() error
}

// tsvWriter writes a header line then one tab-separated line per row. NULL is
// written as NULL, and tabs, newlines and backslashes in values are escaped so
// a row is always one line.
type tsvWriter struct{ w io.Writer }

var tsvEscaper = strings.NewReplacer(`\`, `\\`, "\t", `\t`, "\n", `\n`, "\r", `\r`)

func (t *tsvWriter) start(cols []string) error {
	_, err := fmt.Fprintln(t.w, strings.Join(cols, "\t"))
	return err
}

func (t *tsvWriter) row(vals []any) error {
	cells := make([]string, len(vals))
	for i, v := range vals {
		if v == nil {
			cells[i] = "NULL"
		} else {
			cells[i] = tsvEscaper.Replace(fmt.Sprint(v))
		}
	}
	_, err := fmt.Fprintln(t.w, strings.Join(cells, "\t"))
	return err
}

func (t *tsvWriter) finish() error { return nil }

// jsonWriter writes a JSON array of objects, one row per line.
type jsonWriter struct {
	w    io.Writer
	cols []string
	n    int
}

func (j *jsonWriter) start(cols []string) error {
	j.cols = cols
	_, err := io.WriteString(j.w, "[")
	return err
}

func (j *jsonWriter) row(vals []any) error {
	// Built by hand to keep the columns in query order.
	var b strings.Builder
	if j.n > 0 {
		b.WriteString(",")
	}
	b.WriteString("\n{")
	for i, v := range vals {
		if i > 0 {
			b.WriteString(",")
		}
		k, err := json.Marshal(j.cols[i])
		if err != nil {
			return err
		}
		val, err := json.Marshal(v)
		if err != nil {
			return err
		}
		b.Write(k)
		b.WriteString(":")
		b.Write(val)
	}
	b.WriteString("}")
	j.n++
	_, err := io.WriteString(j.w, b.String())
	return err
}

func (j *jsonWriter) finish() error {
	_, err := io.WriteString(j.w, "\n]\n")
	return err
}
