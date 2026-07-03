import { useDraggable } from '@dnd-kit/core'
import { NODE_DEFS, PALETTE_SECTIONS } from '../nodes/registry'

function PaletteItem({ type }: { type: string }) {
  const def = NODE_DEFS[type]
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { type },
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 10px',
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.5 : 1,
        borderLeft: '2px solid transparent',
        transition: 'all 0.12s',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background = '#252d3d'
        el.style.borderLeftColor = def.color
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background = 'transparent'
        el.style.borderLeftColor = 'transparent'
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: def.color,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 12, color: '#9a9aaa' }}>{def.label}</span>
    </div>
  )
}

export function Palette() {
  return (
    <aside
      style={{
        width: 160,
        background: '#161b27',
        borderRight: '1px solid #2a3349',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflowY: 'auto',
      }}
    >
      {PALETTE_SECTIONS.map((section) => (
        <div key={section.label} style={{ padding: '8px 0 4px' }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.1em',
              color: '#4a5a7a',
              padding: '0 10px 4px',
              textTransform: 'uppercase',
            }}
          >
            {section.label}
          </div>
          {section.types.map((type) => (
            <PaletteItem key={type} type={type} />
          ))}
        </div>
      ))}
    </aside>
  )
}