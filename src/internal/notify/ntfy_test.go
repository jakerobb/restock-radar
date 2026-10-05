package notify

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNtfySend(t *testing.T) {
	var got http.Header
	var status = http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header
		w.WriteHeader(status)
	}))
	defer srv.Close()
	n := NewNtfy(srv.URL, "topic", "tok")

	// Control characters in a store-supplied title must not break the request.
	if err := n.Send(context.Background(), Message{Title: "Bad\r\nTitle\x00", Body: "b", Click: "https://x/\n", Priority: 4, Tags: []string{"a"}}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if got.Get("Title") != "BadTitle" || got.Get("Authorization") != "Bearer tok" || got.Get("Priority") != "4" {
		t.Errorf("unexpected headers: %v", got)
	}

	var perm *PermanentError
	for _, code := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestEntityTooLarge} {
		status = code
		if err := n.Send(context.Background(), Message{Body: "b"}); !errors.As(err, &perm) {
			t.Errorf("HTTP %d should be permanent, got %v", code, err)
		}
	}
	for _, code := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable} {
		status = code
		if err := n.Send(context.Background(), Message{Body: "b"}); err == nil || errors.As(err, &perm) {
			t.Errorf("HTTP %d should be retryable, got %v", code, err)
		}
	}
}

func TestHeaderValueCapsLength(t *testing.T) {
	long := strings.Repeat("é", 400) // 2 bytes each
	got := headerValue(long)
	if len(got) > maxHeaderValue || !strings.HasPrefix(long, got) {
		t.Errorf("len %d, want <= %d and a clean prefix", len(got), maxHeaderValue)
	}
}
