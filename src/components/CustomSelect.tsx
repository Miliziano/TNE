/**
 * src/components/CustomSelect.tsx
 * ─────────────────────────────────
 * Dropdown custom che bypassa lo stile nativo del browser/OS.
 * Usare al posto di <CustomSelect> in tutta l'app.
 *
 * Props identiche a <CustomSelect> per facilitare la migrazione:
 *   value, onChange, disabled, style, children (<option> e <optgroup>)
 *
 * Supporta:
 *   - <option value="x">label</option>
 *   - <optgroup label="Gruppo"><option>...</option></optgroup>
 *   - disabled su singole option
 *   - placeholder (option con value="")
 */

/**
 * src/components/CustomSelect.tsx
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'

interface OptionItem {
  value:     string
  label:     string
  disabled?: boolean
  group?:    string
}

interface SelectProps {
  value:       string
  onChange:    (e: React.ChangeEvent<HTMLSelectElement>) => void
  children:    React.ReactNode
  disabled?:   boolean
  style?:      React.CSSProperties
  className?:  string
  placeholder?: string
}

// ─── Parser children → OptionItem[] ──────────────────────────────
// Gestisce ricorsivamente:
//   - array piatti e annidati (da .map())
//   - <option value="x">label</option>
//   - <optgroup label="Gruppo">...</optgroup>
//   - null / undefined / boolean (React li emette nei condizionali)
function parseChildren(children: React.ReactNode, group?: string): OptionItem[] {
  const items: OptionItem[] = []

  // Normalizza in array piatto ricorsivamente
  const flatten = (node: React.ReactNode, currentGroup?: string) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return

    // Array — può essere un .map() diretto o un array annidato
    if (Array.isArray(node)) {
      node.forEach((child) => flatten(child, currentGroup))
      return
    }

    const el = node as React.ReactElement<any>
    if (!el || !el.type) return

    if (el.type === 'optgroup') {
      const groupLabel = el.props?.label ?? ''
      flatten(el.props?.children, groupLabel)
      return
    }

    if (el.type === 'option') {
      const value    = el.props?.value !== undefined ? String(el.props.value) : ''
      const label    = (() => {
        const c = el.props?.children
        if (c === null || c === undefined) return value
        if (typeof c === 'string' || typeof c === 'number') return String(c)
        if (Array.isArray(c)) return c.map((x: any) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('')
        return value
      })()
      const disabled = el.props?.disabled ?? false
      items.push({ value, label, disabled, group: currentGroup })
      return
    }
  }

  flatten(children, group)
  return items
}

// ─── Componente principale ────────────────────────────────────────
export function CustomSelect({ value, onChange, children, disabled, style, placeholder }: SelectProps) {
  const [open,   setOpen]   = useState(false)
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropRef    = useRef<HTMLDivElement>(null)
  const searchRef  = useRef<HTMLInputElement>(null)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, openUp: false })

  const options = useMemo(() => parseChildren(children), [children])

  const selected     = options.find((o) => o.value === value)
  const displayLabel = selected?.label ?? placeholder ?? '— seleziona —'

  // Filtra per search
  const filtered = useMemo(() => search
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.toLowerCase()) ||
        o.value.toLowerCase().includes(search.toLowerCase())
      )
    : options
  , [options, search])

  // Raggruppa mantenendo ordine
  const groups = useMemo(() => {
    const map = new Map<string, OptionItem[]>()
    for (const opt of filtered) {
      const g = opt.group ?? ''
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(opt)
    }
    return map
  }, [filtered])

  const openDropdown = useCallback(() => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return

    // Calcola se aprire verso l'alto o verso il basso
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const dropH      = Math.min(320, options.length * 32 + 60)
    const openUp     = spaceBelow < dropH && spaceAbove > spaceBelow

    setDropPos({
      top:    openUp
        ? rect.top  + window.scrollY - dropH - 2
        : rect.bottom + window.scrollY + 2,
      left:   rect.left + window.scrollX,
      width:  rect.width,
      openUp,
    })
    setOpen(true)
    setSearch('')
    setTimeout(() => searchRef.current?.focus(), 50)
  }, [disabled, options.length])

  const selectOption = useCallback((opt: OptionItem) => {
    if (opt.disabled) return
    const nativeEvent = { target: { value: opt.value } } as React.ChangeEvent<HTMLSelectElement>
    onChange(nativeEvent)
    setOpen(false)
    setSearch('')
  }, [onChange])

  // Chiudi su click fuori
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as Node)
      const inDrop    = dropRef.current?.contains(e.target as Node)
      if (!inTrigger && !inDrop) { setOpen(false); setSearch('') }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Chiudi su Escape, naviga con tastiera
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setSearch('') }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const isPlaceholder = !value || value === ''

  const triggerStyle: React.CSSProperties = {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            6,
    cursor:         disabled ? 'not-allowed' : 'pointer',
    opacity:        disabled ? 0.5 : 1,
    userSelect:     'none',
    // Default sovrascrivibili da style prop
    width:          '100%',
    background:     '#1e2535',
    border:         '1px solid #3a4a6a',
    borderRadius:   4,
    color:          '#c8d4f0',
    fontFamily:     "'JetBrains Mono', monospace",
    fontSize:       11,
    padding:        '5px 8px',
    ...style,
    // Forza sempre questi
    boxSizing:      'border-box',
    outline:        open ? '1px solid #4a9eff' : 'none',
  }

  return (
    <>
      <div ref={triggerRef} style={triggerStyle} onClick={openDropdown}>
        <span style={{
          flex:         1,
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:   'nowrap',
          color:        isPlaceholder ? '#4a5a7a' : 'inherit',
          fontStyle:    isPlaceholder ? 'italic' : 'normal',
        }}>
          {displayLabel}
        </span>
        <i
          className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`}
          style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }}
        />
      </div>

      {open && createPortal(
        <div ref={dropRef} style={{
          position:      'fixed',
          top:           dropPos.top,
          left:          dropPos.left,
          width:         Math.max(dropPos.width, 200),
          zIndex:        99999,
          background:    '#1a2030',
          border:        '1px solid #3a4a6a',
          borderRadius:  6,
          boxShadow:     '0 8px 32px rgba(0,0,0,.7)',
          overflow:      'hidden',
          maxHeight:     320,
          display:       'flex',
          flexDirection: 'column',
        }}>
          {/* Search — solo se più di 6 opzioni */}
          {options.length > 6 && (
            <div style={{ padding: '6px 8px', borderBottom: '0.5px solid #2a3349', flexShrink: 0, background: '#161b27' }}>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cerca..."
                onClick={(e) => e.stopPropagation()}
                style={{
                  width:       '100%',
                  background:  '#0f1117',
                  border:      '1px solid #2a3349',
                  borderRadius: 4,
                  color:       '#c8d4f0',
                  fontSize:    11,
                  padding:     '4px 8px',
                  outline:     'none',
                  fontFamily:  'inherit',
                }}
              />
            </div>
          )}

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: 11, color: '#4a5a7a', fontStyle: 'italic' }}>
                Nessun risultato
              </div>
            )}

            {[...groups.entries()].map(([groupName, opts]) => (
              <div key={groupName || '__root__'}>
                {groupName && (
                  <div style={{
                    padding:       '5px 10px 3px',
                    fontSize:      9,
                    fontWeight:    700,
                    color:         '#4a5a7a',
                    textTransform: 'uppercase',
                    letterSpacing: '.08em',
                    background:    '#161b27',
                    borderTop:     '0.5px solid #2a3349',
                    borderBottom:  '0.5px solid #2a3349',
                  }}>
                    {groupName}
                  </div>
                )}

                {opts.map((opt) => {
                  const isSelected = opt.value === value
                  const isEmpty    = opt.value === ''
                  return (
                    <div
                      key={`${opt.group ?? ''}__${opt.value}`}
                      onClick={() => selectOption(opt)}
                      style={{
                        padding:      '7px 12px',
                        fontSize:     11,
                        cursor:       opt.disabled ? 'not-allowed' : 'pointer',
                        opacity:      opt.disabled ? 0.4 : 1,
                        color:        isSelected ? '#4a9eff' : isEmpty ? '#4a5a7a' : '#c8d4f0',
                        fontStyle:    isEmpty ? 'italic' : 'normal',
                        background:   isSelected ? 'color-mix(in srgb, #4a9eff 12%, #1a2030)' : 'transparent',
                        fontFamily:   "'JetBrains Mono', monospace",
                        display:      'flex',
                        alignItems:   'center',
                        gap:          6,
                        borderBottom: '0.5px solid #1e2535',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected && !opt.disabled)
                          (e.currentTarget as HTMLElement).style.background = '#1e2535'
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          isSelected ? 'color-mix(in srgb, #4a9eff 12%, #1a2030)' : 'transparent'
                      }}
                    >
                      <i
                        className="ti ti-check"
                        style={{ fontSize: 9, color: '#4a9eff', flexShrink: 0, visibility: isSelected ? 'visible' : 'hidden' }}
                      />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {opt.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}