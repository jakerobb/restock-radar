import { TextInput } from './ui/TextInput'

/** Free-text search over product and variant names. */
export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextInput
      type="search"
      className="min-w-0 flex-1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search products and variants"
      aria-label="Search products and variants"
      autoComplete="off"
    />
  )
}
