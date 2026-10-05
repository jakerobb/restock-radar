import { render, screen } from '@testing-library/react'
import { Badge } from './Badge'
import { Notice } from './Notice'
import { toneClasses } from './tone'

describe('Badge', () => {
  it('takes its colours from the tone map', () => {
    render(<Badge tone="ok">In stock</Badge>)
    for (const cls of toneClasses.ok.split(' ')) expect(screen.getByText('In stock')).toHaveClass(cls)
  })
})

describe('Notice', () => {
  it('announces errors as alerts and successes as status', () => {
    render(
      <>
        <Notice tone="bad">broke</Notice>
        <Notice tone="ok">fine</Notice>
      </>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('broke')
    expect(screen.getByRole('status')).toHaveTextContent('fine')
  })
})
