/**
 * Force-directed graph. Written directly rather than pulling in d3: the layout
 * is about eighty lines, and owning it means canon/chronicle layering and edge
 * predicates can be rendered exactly as the design wants them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Entity } from '../api.ts';

interface Node {
  id: string;
  label: string;
  type: string;
  layer: string;
  salience: number;
  emergent: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const TYPE_COLOR: Record<string, string> = {
  Character: '#c9a227',
  Location: '#6b8fb5',
  Faction: '#b5766b',
  Item: '#7a9a6b',
  Concept: '#8f7fb5',
  Event: '#b59a6b',
};

export function GraphView({
  entities,
  edges,
  onSelect,
  selectedId,
}: {
  entities: Entity[];
  edges: Edge[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id: string | null; panning: boolean; lastX: number; lastY: number }>({
    id: null, panning: false, lastX: 0, lastY: 0,
  });

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.subject)) m.set(e.subject, new Set());
      if (!m.has(e.object)) m.set(e.object, new Set());
      m.get(e.subject)!.add(e.object);
      m.get(e.object)!.add(e.subject);
    }
    return m;
  }, [edges]);

  // Seed positions on a circle, ordered so connected nodes start near each other.
  useEffect(() => {
    setNodes(
      entities.map((e, i) => {
        const angle = (i / Math.max(1, entities.length)) * Math.PI * 2;
        const radius = 190 + (1 - e.salience) * 130;
        return {
          id: e.id,
          label: e.name,
          type: e.type,
          layer: e.layer,
          salience: e.salience,
          emergent: e.provenance.startsWith('emergent'),
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        };
      }),
    );
  }, [entities]);

  // Simulation: repulsion between all pairs, springs along edges, weak centring.
  // Cheap enough at a few hundred nodes to run without quadtree bookkeeping.
  useEffect(() => {
    if (!nodes.length) return;
    let frame = 0;
    let alpha = 1;

    const step = () => {
      alpha *= 0.985;
      if (alpha < 0.005) return;

      setNodes((prev) => {
        const next = prev.map((n) => ({ ...n }));
        const byId = new Map(next.map((n) => [n.id, n]));

        for (let i = 0; i < next.length; i++) {
          for (let j = i + 1; j < next.length; j++) {
            const a = next[i]!;
            const b = next[j]!;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              // Deterministic nudge rather than random, so layouts are stable.
              dx = (i % 2 ? 1 : -1) * 0.5;
              dy = (j % 2 ? 1 : -1) * 0.5;
              d2 = 0.5;
            }
            const d = Math.sqrt(d2);
            const force = (adjacency.get(a.id)?.has(b.id) ? 2600 : 4200) / d2;
            const fx = (dx / d) * force;
            const fy = (dy / d) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        for (const e of edges) {
          const a = byId.get(e.subject);
          const b = byId.get(e.object);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          // Stronger edges pull shorter: weight becomes visible as proximity.
          const target = 130 - e.weight * 45;
          const f = (d - target) * 0.012 * (0.35 + e.weight);
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }

        for (const n of next) {
          n.vx -= n.x * 0.0035;
          n.vy -= n.y * 0.0035;
          if (drag.current.id === n.id) {
            n.vx = 0;
            n.vy = 0;
            continue;
          }
          n.vx *= 0.82;
          n.vy *= 0.82;
          n.x += Math.max(-16, Math.min(16, n.vx * alpha));
          n.y += Math.max(-16, Math.min(16, n.vy * alpha));
        }
        return next;
      });
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [edges, adjacency, nodes.length]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - rect.width / 2) / view.k - view.x,
      y: (clientY - rect.top - rect.height / 2) / view.k - view.y,
    };
  };

  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    drag.current = { id: id ?? null, panning: !id, lastX: e.clientX, lastY: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.id) {
      const p = toWorld(e.clientX, e.clientY);
      setNodes((prev) => prev.map((n) => (n.id === d.id ? { ...n, x: p.x, y: p.y, vx: 0, vy: 0 } : n)));
    } else if (d.panning) {
      const dx = (e.clientX - d.lastX) / view.k;
      const dy = (e.clientY - d.lastY) / view.k;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };

  const onPointerUp = () => {
    drag.current = { id: null, panning: false, lastX: 0, lastY: 0 };
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const neighbours = selectedId ? adjacency.get(selectedId) : undefined;

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <button onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.25) }))}>+</button>
        <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.25) }))}>−</button>
        <button onClick={() => setView({ x: 0, y: 0, k: 1 })}>reset</button>
      </div>

      <svg
        ref={svgRef}
        viewBox="-500 -350 1000 700"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`scale(${view.k}) translate(${view.x} ${view.y})`}>
          {edges.map((e) => {
            const a = byId.get(e.subject);
            const b = byId.get(e.object);
            if (!a || !b) return null;
            const active = !selectedId || e.subject === selectedId || e.object === selectedId;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return (
              <g key={e.id} opacity={active ? 1 : 0.16}>
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={e.layer === 'canon' ? '#3d4a57' : '#57403d'}
                  strokeWidth={0.6 + e.weight * 1.5}
                />
                {active && selectedId ? (
                  <text x={mx} y={my - 3} fill="#6b6559" fontSize="7" textAnchor="middle" fontFamily="monospace">
                    {e.predicate.toLowerCase().replace(/_/g, ' ')}
                  </text>
                ) : null}
              </g>
            );
          })}

          {nodes.map((n) => {
            const r = 4.5 + n.salience * 7;
            const selected = n.id === selectedId;
            const related = !selectedId || selected || neighbours?.has(n.id);
            return (
              <g
                key={n.id}
                opacity={related ? 1 : 0.22}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, n.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(n.id);
                }}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={n.x} cy={n.y} r={r}
                  fill={TYPE_COLOR[n.type] ?? '#8a8378'}
                  stroke={selected ? '#e8e2d4' : n.emergent ? '#b5766b' : 'none'}
                  strokeWidth={selected ? 2 : n.emergent ? 1.4 : 0}
                  strokeDasharray={n.emergent && !selected ? '2 1.5' : undefined}
                />
                <text
                  x={n.x} y={n.y - r - 3.5}
                  fill={selected ? '#e8e2d4' : '#97907f'}
                  fontSize={selected ? 10 : 8.5}
                  textAnchor="middle"
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="legend">
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} style={{ marginRight: 10 }}>
            <i style={{ background: c }} />
            {t}
          </span>
        ))}
        <span>
          <i style={{ border: '1.4px dashed #b5766b', background: 'none' }} />
          emergent
        </span>
      </div>
    </div>
  );
}
