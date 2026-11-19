package specs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "record the current derivation in testdata/derivation.golden")

const goldenFile = "testdata/derivation.golden"

// derivationHash fingerprints what Derive produces for every captured product.
func derivationHash(t *testing.T) string {
	t.Helper()
	fx := fixtures(t)
	slugs := make([]string, 0, len(fx))
	for s := range fx {
		slugs = append(slugs, s)
	}
	sort.Strings(slugs)
	h := sha256.New()
	for _, s := range slugs {
		b, err := json.Marshal(derived(t, s))
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(h, "%s\n%s\n", s, b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func readGolden(t *testing.T) (version int, hash string) {
	t.Helper()
	b, err := os.ReadFile(goldenFile)
	if os.IsNotExist(err) && *update {
		return 0, ""
	}
	if err != nil {
		t.Fatalf("%v; run: go test ./internal/specs -run TestDerivationVersion -update", err)
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(string(b)), "version=%d hash=%s", &version, &hash); err != nil {
		t.Fatalf("%s is malformed: %v", goldenFile, err)
	}
	return version, hash
}

// TestDerivationVersion fails when what the parsers produce for the captured
// products changes without Version changing: stored derived data is only
// recomputed at startup when Version changes, so existing products would keep
// the old numbers.
func TestDerivationVersion(t *testing.T) {
	got := derivationHash(t)
	if again := derivationHash(t); again != got {
		t.Fatal("derivation is not deterministic: two runs over the same fixtures differ")
	}
	oldVersion, oldHash := readGolden(t)

	if *update {
		if oldHash != "" && got != oldHash && Version == oldVersion {
			t.Fatalf("the derivation's output changed, so bump Version in normalize.go (now %d) before running -update", Version)
		}
		line := fmt.Sprintf("version=%d hash=%s\n", Version, got)
		if err := os.WriteFile(goldenFile, []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}

	const record = "then record it: go test ./internal/specs -run TestDerivationVersion -update"
	switch {
	case got != oldHash && Version == oldVersion:
		t.Fatalf("the derivation's output changed but Version is still %d. Bump Version in normalize.go so existing products are re-derived; %s", Version, record)
	case got != oldHash:
		t.Fatalf("the derivation's output changed and Version is now %d (was %d); %s", Version, oldVersion, record)
	case Version != oldVersion:
		t.Fatalf("Version is %d but %s records %d for the same output; %s", Version, goldenFile, oldVersion, record)
	}
}
