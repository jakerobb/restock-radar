import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SwitchFinder } from './SwitchFinder'

describe('SwitchFinder', () => {
  it('offers hot-swappable power supplies below the power methods, and only while AC is accepted', async () => {
    const user = userEvent.setup()
    render(<SwitchFinder plan={[]} products={[]} derived={[]} onAdd={() => {}} onClose={() => {}} />)
    const crps = () => screen.queryByRole('checkbox', { name: /Hot-swappable power supplies/ })
    expect(screen.getByRole('checkbox', { name: 'AC' })).toBeChecked() // AC and PoE are the defaults
    expect(crps()).toBeInTheDocument()
    // It follows the power methods in the page, not the mounting row above them.
    expect(crps()!.compareDocumentPosition(screen.getByRole('checkbox', { name: 'PoE' })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    await user.click(screen.getByRole('checkbox', { name: 'AC' }))
    expect(crps()).not.toBeInTheDocument()
  })
})
