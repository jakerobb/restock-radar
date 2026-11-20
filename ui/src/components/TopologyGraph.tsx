import { useState } from 'react'
import type { Topology, TopoNode } from '../lib/topology'
import { Button } from './ui/Button'
import { Card } from './ui/Card'

/** A line of small print in a box: something left-aligned and something right-aligned, each optional. */
function Row({ left, leftClass = 'text-muted', right, rightClass = 'text-muted' }: { left?: string; leftClass?: string; right?: string; rightClass?: string }) {
  if (!left && !right) return null
  return (
    <div className="mt-0.5 flex justify-between gap-4 whitespace-nowrap text-left text-xs">
      <span className={leftClass}>{left}</span>
      <span className={`text-right ${rightClass}`}>{right}</span>
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const watts = (w: number) => Math.round(w * 10) / 10

function Box({ node, hot, onHot }: { node: TopoNode; hot: boolean; onHot: (n: TopoNode | null) => void }) {
  const tone = node.problem ? 'border-dashed border-bad' : node.kind === 'gateway' ? 'border-accent' : node.kind === 'switch' ? 'border-ink/40' : 'border-line'
  const { poe } = node
  const near = poe !== undefined && poe.budgetW !== null && poe.usedW >= 0.9 * poe.budgetW
  return (
    <div className={`rounded-lg border bg-surface px-3 py-1.5 text-center text-sm ${tone} ${hot ? 'ring-2 ring-accent' : ''}`} onMouseEnter={() => onHot(node)} onMouseLeave={() => onHot(null)}>
      {node.title}
      {node.qty > 1 && <span className="text-muted"> × {node.qty}</span>}
      <Row left={node.uplink && `Uplink: ${node.uplink.label}`} leftClass={node.uplink?.slow ? 'text-warn' : 'text-muted'} right={node.spare !== undefined ? `${plural(node.spare, 'spare port', 'spare ports')}` : undefined} />
      {poe && <Row left={`PoE: ${watts(poe.usedW)}${poe.budgetW !== null ? ` / ${poe.budgetW}` : ''} W`} leftClass={near ? 'text-warn' : 'text-muted'} right={plural(poe.sparePorts, 'spare PoE port', 'spare PoE ports')} />}
      <Row left={node.rack === undefined ? undefined : node.rack === 'desktop' ? 'Desktop' : `${node.rack}U rack`} right={node.outlets === undefined ? undefined : plural(node.outlets, 'AC outlet', 'AC outlets')} />
      <Row left={node.problem} leftClass="text-bad" right={node.stock && (node.stock === 'out' ? 'Out of stock' : 'Coming soon')} rightClass={node.stock === 'out' ? 'text-bad' : 'text-warn'} />
    </div>
  )
}

function Branch({ node, hotCheck, onHot }: { node: TopoNode; hotCheck: string | null; onHot: (n: TopoNode | null) => void }) {
  // The line from its parent says how fast the link runs; one that runs slower than it could, or that isn't there, is drawn dashed.
  const link = node.problem ? 'bad' : node.uplink?.slow ? 'slow' : ''
  return (
    <li>
      {node.uplink?.speed || link ? (
        <span className={`topo-link ${link}`} aria-hidden>
          {node.uplink?.speed}
        </span>
      ) : null}
      <Box node={node} hot={hotCheck !== null && node.checks.includes(hotCheck)} onHot={onHot} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Branch key={c.key} node={c} hotCheck={hotCheck} onHot={onHot} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The plan's devices as a family tree: the gateway at the top, what plugs into it below, and so on. Nothing is to scale.
 * Boxes say how they are plugged in and what they take; what has nothing to plug into hangs, dashed, from the first root.
 * Hovering a box tells `onHot`, and `hotCheck` (a check's id) outlines the boxes that check is about.
 * A section that opens and closes, open or not as the caller says.
 */
export const ZOOMS = [50, 75, 100, 125, 150, 200]

export function TopologyGraph({ topology, open, hotCheck = null, onHot = () => {} }: { topology: Topology; open: boolean; hotCheck?: string | null; onHot?: (n: TopoNode | null) => void }) {
  const [zoom, setZoom] = useState(100)
  const step = (d: number) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + d))]!)
  return (
    <Card className="mt-4" aria-label="Topology">
      {/* Keyed by the default, so crossing the breakpoint sets it again, while a click in between sticks. */}
      <details key={String(open)} open={open}>
        <summary className="cursor-pointer text-lg font-semibold">Topology</summary>
        <div className="mt-2 flex items-center justify-end gap-1" role="group" aria-label="Zoom">
          <Button variant="secondary" className="px-2 py-0.5 text-sm" onClick={() => step(-1)} disabled={zoom === ZOOMS[0]} aria-label="Zoom out" title="Zoom out">
            −
          </Button>
          <Button variant="secondary" className="min-w-14 px-2 py-0.5 text-sm tabular-nums" onClick={() => setZoom(100)} disabled={zoom === 100} aria-label="Reset zoom" title="Reset zoom">
            {zoom}%
          </Button>
          <Button variant="secondary" className="px-2 py-0.5 text-sm" onClick={() => step(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in" title="Zoom in">
            +
          </Button>
        </div>
        <div className="mt-2 overflow-x-auto pb-1">
          {/* The CSS zoom property resizes the layout, so the scroll area follows it. */}
          <div style={{ zoom: zoom / 100 }}>
            <ul className="topo-roots topo mx-auto w-max gap-8" aria-label="Device topology">
              {topology.roots.map((r) => (
                <Branch key={r.key} node={r} hotCheck={hotCheck} onHot={onHot} />
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">One possible arrangement that satisfies the checks. Devices are not to scale. A dashed line is a link slower than the device could do, or something with nothing to plug into.</p>
      </details>
    </Card>
  )
}
