package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/jakerobb/restock-radar/internal/config"
	"github.com/jakerobb/restock-radar/internal/dbquery"
	"github.com/jakerobb/restock-radar/internal/util"
)

const queryUsage = `usage: restock-radar query [flags] "SELECT ..."
       restock-radar query --schema

Runs one read-only SQL statement against the database (db_path from the
config, or --db) and prints the rows. It can't change anything and doesn't
stop the running service, so it is safe to run in the pod:

  kubectl exec -n restock-radar deploy/restock-radar -- /restock-radar query "SELECT ..."

Flags go before the statement. "-" reads the statement from stdin.
`

// runQuery is the "query" subcommand. It returns the process exit code.
func runQuery(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("query", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { _, _ = fmt.Fprint(stderr, queryUsage); fs.PrintDefaults() }
	asJSON := fs.Bool("json", false, "print a JSON array of objects instead of tab-separated text")
	schema := fs.Bool("schema", false, "print every table, index and view with its definition")
	limit := fs.Int("limit", 1000, "most rows to print; 0 for no limit")
	dbPath := fs.String("db", "", "database file (default: db_path from the config)")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}

	var query string
	switch {
	case *schema && fs.NArg() == 0:
		query = dbquery.SchemaQuery
	case *schema:
		_, _ = fmt.Fprintln(stderr, "--schema takes no statement")
		return 2
	case fs.NArg() == 1 && fs.Arg(0) == "-":
		b, err := io.ReadAll(stdin)
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "reading statement:", err)
			return 1
		}
		query = string(b)
	case fs.NArg() > 0:
		query = strings.Join(fs.Args(), " ")
	}
	if strings.TrimSpace(query) == "" {
		fs.Usage()
		return 2
	}

	path := *dbPath
	if path == "" {
		cfg, err := config.Load()
		if err != nil {
			_, _ = fmt.Fprintln(stderr, "can't find the database (pass --db, or fix the config):", err)
			return 1
		}
		path = cfg.DBPath
	}

	db, err := dbquery.Open(path)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	defer util.CloseCleanly(db)

	format := dbquery.TSV
	if *asJSON {
		format = dbquery.JSON
	}
	truncated, err := dbquery.Run(context.Background(), db, query, stdout, format, *limit)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "query failed:", err)
		return 1
	}
	if truncated {
		_, _ = fmt.Fprintf(stderr, "(stopped at %d rows; raise --limit, or 0 for all)\n", *limit)
	}
	return 0
}
