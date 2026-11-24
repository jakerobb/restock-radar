import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { variant } from '../test/fixtures'
import { VariantRow } from './VariantRow'

function renderRow(overrides: Parameters<typeof variant>[0]) {
  render(
    <table>
      <tbody>
        <VariantRow variant={variant(overrides)} />
      </tbody>
    </table>,
  )
}

describe('VariantRow', () => {
  it('says what changed before when', () => {
    renderRow({ last_change: 'Memory surcharge added' })
    expect(screen.getByText(/^Memory surcharge added/)).toHaveTextContent(/^Memory surcharge added just now$/)
  })

  it('shows only when if what changed is unknown', () => {
    renderRow({})
    expect(screen.getByText('just now')).toBeInTheDocument()
  })
})
