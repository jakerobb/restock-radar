package api

import "github.com/jakerobb/restock-radar/internal/category"

// typeBySlug files products whose category says one thing and whose nature
// another. Both are mounting enclosures for Flex switches, which the store lists
// under "switching-utility" beside the switches themselves; they have no ports,
// so left among the switches they would never match a search for any.
var typeBySlug = map[string]string{
	"usw-flexutility":       category.Accessories,
	"uacc-flex-utility-pro": category.Accessories,
}

// productType names the type of a product given its store category id and slug,
// or "" when the category is unknown (not yet polled since categories were
// recorded).
func productType(categoryID, slug string) string {
	if t, ok := typeBySlug[slug]; ok {
		return t
	}
	return category.Type(categoryID)
}
