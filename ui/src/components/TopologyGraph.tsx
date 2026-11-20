import type { Topology, TopoNode } from '../lib/topology'
import { Card } from './ui/Card'

function Box({ node }: { node: TopoNode }) {
  const tone = node.kind === 'gateway' ? 'border-accent' : node.kind === 'switch' ? 'border-ink/40' : 'border-line'
  return (
    <div className={`rounded-lg border bg-surface px-3 py-1.5 text-center text-sm ${tone}`}>
      {node.title}
      {node.qty > 1 && <span className="text-muted"> × {node.qty}</span>}
    </div>
  )
}

function Branch({ node }: { node: TopoNode }) {
  return (
    <li>
      <Box node={node} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Branch key={c.key} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The plan's devices as a family tree: the gateway at the top, what plugs into it below, and so on. Boxes carry
 * product names only; nothing is to scale. A section that opens and closes, open or not as the caller says.
 */
export function TopologyGraph({ topology, open }: { topology: Topology; open: boolean }) {
  return (
    <Card className="mt-4" aria-label="Topology">
      {/* Keyed by the default, so crossing the breakpoint sets it again, while a click in between sticks. */}
      <details key={String(open)} open={open}>
        <summary className="cursor-pointer text-lg font-semibold">Topology</summary>
        <div className="mt-3 overflow-x-auto pb-1">
          <ul className="topo-roots topo mx-auto w-max gap-8" aria-label="Device topology">
            {topology.roots.map((r) => (
              <Branch key={r.key} node={r} />
            ))}
          </ul>
          {topology.unconnected.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-sm text-muted">Nothing to plug these into:</div>
              <ul className="flex flex-wrap gap-2">
                {topology.unconnected.map((n) => (
                  <li key={n.key}>
                    <div className="rounded-lg border border-dashed border-warn bg-surface px-3 py-1.5 text-center text-sm">
                      {n.title}
                      {n.qty > 1 && <span className="text-muted"> × {n.qty}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">One arrangement the checks found, not to scale.</p>
      </details>
    </Card>
  )
}
