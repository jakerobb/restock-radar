package notify

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/util"
)

// Ntfy publishes to a topic on an ntfy server.
type Ntfy struct {
	endpoint string
	token    string
	client   *http.Client
}

func NewNtfy(baseURL, topic, token string) *Ntfy {
	return &Ntfy{
		endpoint: strings.TrimRight(baseURL, "/") + "/" + url.PathEscape(topic),
		token:    token,
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

func (n *Ntfy) Send(ctx context.Context, m Message) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.endpoint, strings.NewReader(m.Body))
	if err != nil {
		return err
	}
	if m.Title != "" {
		req.Header.Set("Title", m.Title)
	}
	if m.Click != "" {
		req.Header.Set("Click", m.Click)
	}
	if m.Priority != 0 {
		req.Header.Set("Priority", strconv.Itoa(m.Priority))
	}
	if len(m.Tags) > 0 {
		req.Header.Set("Tags", strings.Join(m.Tags, ","))
	}
	if n.token != "" {
		req.Header.Set("Authorization", "Bearer "+n.token)
	}

	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer util.CloseCleanly(resp.Body)
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("ntfy returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
