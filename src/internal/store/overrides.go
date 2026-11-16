package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jakerobb/restock-radar/internal/specs"
	"github.com/jakerobb/restock-radar/internal/unistore"
)

var (
	// ErrUnknownProduct means an override names a product we don't track.
	ErrUnknownProduct = errors.New("no such product")
	// ErrInvalidOverride means an override can't be stored as given; the message
	// says why and is fit to show the user.
	ErrInvalidOverride = errors.New("invalid override")
)

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidOverride, fmt.Sprintf(format, a...))
}

// OverrideStatus is an override with what it currently does.
type OverrideStatus struct {
	specs.Override
	// Status is what the override does to its product's specification now:
	// "overrides", "hides", "adds" or "orphan" (see specs.Applied), or
	// "unknown_product" if the product isn't tracked (yet).
	Status string `json:"status"`
	// Stale is set when the store's published value has changed since the
	// override was made.
	Stale bool `json:"stale"`
	// PublishedNow is the value the store publishes now for the entry the
	// override targets, nil when there is none.
	PublishedNow *string `json:"published_now"`
}

const statusUnknownProduct = "unknown_product"

// UpsertOverride stores an override, replacing any with the same target, and
// derives its product's facts again. It records the value the store publishes
// for the target now, so a later change to it can be noticed.
func (s *Store) UpsertOverride(ctx context.Context, o specs.Override, now time.Time) (OverrideStatus, error) {
	o.Section, o.Group, o.Label = specs.NormalizeTarget(o.Section, o.Group, o.Label)
	o.Kind = strings.TrimSpace(o.Kind)
	switch {
	case o.Action != specs.ActionSet && o.Action != specs.ActionHide:
		return OverrideStatus{}, invalid("action must be %q or %q", specs.ActionSet, specs.ActionHide)
	case o.Section == "" || o.Label == "":
		return OverrideStatus{}, invalid("section and label are required")
	case o.Kind != "" && o.Kind != unistore.SpecText && o.Kind != unistore.SpecFlag:
		return OverrideStatus{}, invalid("kind must be %q or %q", unistore.SpecText, unistore.SpecFlag)
	}
	if o.Action == specs.ActionHide {
		o.Kind, o.Value, o.Note = "", "", ""
	} else {
		o.Value = strings.TrimSpace(o.Value)
		if o.Value == "" {
			return OverrideStatus{}, invalid("a value is required (to remove an entry, hide it)")
		}
		if o.Kind == unistore.SpecFlag && o.Value != "true" && o.Value != "false" {
			return OverrideStatus{}, invalid("a flag's value must be true or false")
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OverrideStatus{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var productID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM products WHERE region = ? AND slug = ?`, o.Region, o.Slug).Scan(&productID)
	if errors.Is(err, sql.ErrNoRows) {
		return OverrideStatus{}, ErrUnknownProduct
	}
	if err != nil {
		return OverrideStatus{}, err
	}
	raw, err := rawSpecsTx(ctx, tx, o.Region, productID)
	if err != nil {
		return OverrideStatus{}, err
	}
	if specs.IsGroup(raw, o.Section, o.Group, o.Label) {
		return OverrideStatus{}, invalid("%q is a group heading; override an entry under it", o.Label)
	}
	pub, found := specs.FindPublished(raw, o.Section, o.Group, o.Label)
	if o.Action == specs.ActionHide && !found {
		return OverrideStatus{}, invalid("nothing to hide: %s has no %q entry in %q", o.Slug, o.Label, o.Section)
	}
	var published any
	if found {
		published = pub.Value
		if o.Kind == "" {
			// A flag stays a flag unless said otherwise; this is only to validate.
			if pub.Kind == unistore.SpecFlag && o.Action == specs.ActionSet && o.Value != "true" && o.Value != "false" {
				return OverrideStatus{}, invalid("%q is a yes/no entry; its value must be true or false", o.Label)
			}
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO spec_overrides (region, slug, action, section, group_label, label, kind, value, note, source_url, reason, published_value, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (region, slug, lower(section), lower(group_label), lower(label)) DO UPDATE SET
			action = excluded.action, section = excluded.section, group_label = excluded.group_label, label = excluded.label,
			kind = excluded.kind, value = excluded.value, note = excluded.note, source_url = excluded.source_url, reason = excluded.reason,
			published_value = excluded.published_value, updated_at = excluded.updated_at`,
		o.Region, o.Slug, o.Action, o.Section, o.Group, o.Label, o.Kind, o.Value, strings.TrimSpace(o.Note),
		strings.TrimSpace(o.SourceURL), strings.TrimSpace(o.Reason), published, ts(now), ts(now))
	if err != nil {
		return OverrideStatus{}, fmt.Errorf("storing override: %w", err)
	}
	if err := rederiveTx(ctx, tx, o.Region, productID, now); err != nil {
		return OverrideStatus{}, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM spec_overrides WHERE region = ? AND slug = ? AND lower(section) = lower(?) AND lower(group_label) = lower(?) AND lower(label) = lower(?)`,
		o.Region, o.Slug, o.Section, o.Group, o.Label).Scan(&id); err != nil {
		return OverrideStatus{}, err
	}
	if err := tx.Commit(); err != nil {
		return OverrideStatus{}, err
	}
	got, err := s.OverrideByID(ctx, id)
	if err != nil {
		return OverrideStatus{}, err
	}
	return *got, nil
}

// DeleteOverride removes an override and derives its product's facts again. It
// reports whether there was one.
func (s *Store) DeleteOverride(ctx context.Context, id int64, now time.Time) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	ovs, err := queryOverrides(ctx, tx, `WHERE id = ?`, id)
	if err != nil || len(ovs) == 0 {
		return false, err
	}
	o := ovs[0]
	if _, err := tx.ExecContext(ctx, `DELETE FROM spec_overrides WHERE id = ?`, id); err != nil {
		return false, err
	}
	var productID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM products WHERE region = ? AND slug = ?`, o.Region, o.Slug).Scan(&productID)
	switch {
	case err == nil:
		if err := rederiveTx(ctx, tx, o.Region, productID, now); err != nil {
			return false, err
		}
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	return true, tx.Commit()
}

// OverrideByID returns one override with its status, or nil if there is none.
func (s *Store) OverrideByID(ctx context.Context, id int64) (*OverrideStatus, error) {
	ovs, err := queryOverrides(ctx, s.db, `WHERE id = ?`, id)
	if err != nil || len(ovs) == 0 {
		return nil, err
	}
	sts, err := s.statuses(ctx, ovs)
	if err != nil {
		return nil, err
	}
	return &sts[0], nil
}

// Overrides lists overrides with what each does, oldest first. An empty region
// or slug matches any.
func (s *Store) Overrides(ctx context.Context, region, slug string) ([]OverrideStatus, error) {
	ovs, err := queryOverrides(ctx, s.db, `WHERE (? = '' OR region = ?) AND (? = '' OR slug = ?) ORDER BY id`, region, region, slug, slug)
	if err != nil {
		return nil, err
	}
	return s.statuses(ctx, ovs)
}

// statuses works out what each override does, by applying each product's
// overrides to its specification together.
func (s *Store) statuses(ctx context.Context, ovs []specs.Override) ([]OverrideStatus, error) {
	type key struct{ region, slug string }
	byProduct := map[key][]specs.Override{}
	for _, o := range ovs {
		k := key{o.Region, o.Slug}
		byProduct[k] = append(byProduct[k], o)
	}
	applied := map[int64]specs.Applied{}
	published := map[int64]*string{}
	unknown := map[key]bool{}
	for k := range byProduct {
		var productID string
		err := s.db.QueryRowContext(ctx, `SELECT id FROM products WHERE region = ? AND slug = ?`, k.region, k.slug).Scan(&productID)
		if errors.Is(err, sql.ErrNoRows) {
			unknown[k] = true
			continue
		}
		if err != nil {
			return nil, err
		}
		raw, err := rawSpecsTx(ctx, s.db, k.region, productID)
		if err != nil {
			return nil, err
		}
		// Statuses depend on the product's whole set of overrides (an added entry
		// can sit under another's group), so apply all of them.
		all, err := overridesTx(ctx, s.db, k.region, k.slug)
		if err != nil {
			return nil, err
		}
		_, ap := specs.Apply(raw, all)
		for _, a := range ap {
			applied[a.OverrideID] = a
		}
		for _, o := range byProduct[k] {
			if e, ok := specs.FindPublished(raw, o.Section, o.Group, o.Label); ok {
				v := e.Value
				published[o.ID] = &v
			}
		}
	}
	out := make([]OverrideStatus, len(ovs))
	for i, o := range ovs {
		st := OverrideStatus{Override: o, Status: statusUnknownProduct}
		if a, ok := applied[o.ID]; ok {
			st.Status, st.Stale = a.Status, a.Stale
		}
		st.PublishedNow = published[o.ID]
		out[i] = st
	}
	return out, nil
}
