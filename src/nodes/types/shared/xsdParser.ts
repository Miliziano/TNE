/**
 * src/nodes/types/shared/xsdParser.ts
 *
 * Parser XSD condiviso tra XmlSerializerModal e XmlParserModal.
 * Risolve complexType, attributeGroup, sequence, tipi per riferimento.
 * Restituisce XsdNode[] — struttura neutrale che ogni componente
 * converte nel proprio tipo (XmlTreeNode, JsonTreeNode, ecc.).
 */

// ─── Tipo risultato ───────────────────────────────────────────────
export type XsdNodeKind = 'element' | 'attribute' | 'group'

export interface XsdNode {
  name:     string
  kind:     XsdNodeKind
  optional: boolean        // minOccurs="0"
  multiple: boolean        // maxOccurs="unbounded" o >1
  ns:       string         // prefisso namespace se presente nel nome
  children: XsdNode[]
}

// ─── Parser principale ────────────────────────────────────────────
export function parseXsd(xsdText: string): XsdNode[] {
  try {
    const doc = new DOMParser().parseFromString(xsdText, 'application/xml')
    if (doc.querySelector('parsererror')) return []

    // Rimuove prefisso namespace dal nome (es. "tst:tTrack" → "tTrack")
    const stripPfx = (name: string | null) => (name ?? '').split(':').pop() ?? ''

    // Raccoglie definizioni globali per nome
    const complexTypes = new Map<string, Element>()
    const attrGroups   = new Map<string, Element>()
    const simpleTypes  = new Set<string>()

    // Tipi primitivi XSD — foglie per definizione
    const XS_PRIMITIVES = new Set([
      'string','boolean','decimal','integer','float','double',
      'date','time','dateTime','duration','anyURI','base64Binary',
      'hexBinary','QName','NOTATION','normalizedString','token',
      'language','NMTOKEN','Name','NCName','ID','IDREF','ENTITY',
      'nonNegativeInteger','positiveInteger','nonPositiveInteger',
      'negativeInteger','long','int','short','byte',
      'unsignedLong','unsignedInt','unsignedShort','unsignedByte',
      'gYear','gYearMonth','gMonth','gMonthDay','gDay',
    ])

    const isPrimitive = (typeRef: string) => {
      const local = stripPfx(typeRef)
      return typeRef.startsWith('xs:') || XS_PRIMITIVES.has(local) || simpleTypes.has(local)
    }

    // Prima passata: raccoglie tutte le definizioni globali
    Array.from(doc.documentElement.children).forEach((child) => {
      const name = child.getAttribute('name')
      if (!name) return
      switch (child.localName) {
        case 'complexType': complexTypes.set(name, child); break
        case 'attributeGroup': attrGroups.set(name, child); break
        case 'simpleType': simpleTypes.add(name); break
      }
    })

    // Figli diretti di sequence/all/choice (non ricorsivi)
    function directElements(parent: Element): Element[] {
      const seq = Array.from(parent.children).find((c) =>
        c.localName === 'sequence' || c.localName === 'all' || c.localName === 'choice'
      )
      if (!seq) return []
      return Array.from(seq.children).filter((c) => c.localName === 'element')
    }

    // Attributi + attributeGroup di un complexType
    function collectAttrs(ct: Element, visited: Set<string>): XsdNode[] {
      const attrs: XsdNode[] = []

      Array.from(ct.children).forEach((child) => {
        if (child.localName === 'attribute') {
          const name = child.getAttribute('name')
          if (name) attrs.push({
            name, kind: 'attribute', optional: child.getAttribute('use') !== 'required',
            multiple: false, ns: '', children: [],
          })
        }
        if (child.localName === 'attributeGroup') {
          const ref = stripPfx(child.getAttribute('ref') ?? '')
          const ag  = attrGroups.get(ref)
          if (ag && !visited.has('ag:' + ref)) {
            visited.add('ag:' + ref)
            Array.from(ag.children)
              .filter((c) => c.localName === 'attribute')
              .forEach((a) => {
                const name = a.getAttribute('name')
                if (name) attrs.push({
                  name, kind: 'attribute', optional: a.getAttribute('use') !== 'required',
                  multiple: false, ns: '', children: [],
                })
              })
          }
        }
      })

      // Cerca anche in sequence > attribute (raro ma possibile)
      const seq = Array.from(ct.children).find((c) =>
        c.localName === 'sequence' || c.localName === 'all'
      )
      if (seq) {
        Array.from(seq.children)
          .filter((c) => c.localName === 'attribute')
          .forEach((a) => {
            const name = a.getAttribute('name')
            if (name) attrs.push({
              name, kind: 'attribute', optional: a.getAttribute('use') !== 'required',
              multiple: false, ns: '', children: [],
            })
          })
      }

      return attrs
    }

    // Costruisce un XsdNode da un xs:element
    function buildNode(el: Element, depth: number, visited: Set<string>): XsdNode {
      const rawName  = el.getAttribute('name') ?? '?'
      const typeRef  = el.getAttribute('type') ?? ''
      const localType = stripPfx(typeRef)
      const optional = (el.getAttribute('minOccurs') ?? '1') === '0'
      const maxOcc   = el.getAttribute('maxOccurs') ?? '1'
      const multiple = maxOcc === 'unbounded' || (parseInt(maxOcc, 10) > 1)

      // Estrae eventuale prefisso namespace dal nome
      const nsParts = rawName.includes(':') ? rawName.split(':') : ['', rawName]
      const ns      = nsParts.length > 1 ? nsParts[0] : ''
      const name    = nsParts[nsParts.length - 1]

      const node: XsdNode = { name, kind: 'element', optional, multiple, ns, children: [] }

      if (depth >= 10) return node  // protezione profondità

      // Cerca complexType: inline oppure per riferimento
      let ct: Element | null = Array.from(el.children).find((c) => c.localName === 'complexType') ?? null

      if (!ct && localType && !isPrimitive(typeRef) && !visited.has(localType)) {
        ct = complexTypes.get(localType) ?? null
      }

      if (ct) {
        const newVisited = new Set(visited)
        if (localType) newVisited.add(localType)

        // Attributi prima (convenzione: prima gli attr, poi i figli)
        node.children.push(...collectAttrs(ct, new Set(newVisited)))

        // Figli elemento diretti
        directElements(ct).forEach((childEl) => {
          node.children.push(buildNode(childEl, depth + 1, newVisited))
        })

        // Gestisce complexContent / extension / restriction
        const complexContent = Array.from(ct.children).find((c) =>
          c.localName === 'complexContent' || c.localName === 'simpleContent'
        )
        if (complexContent) {
          const extension = Array.from(complexContent.children).find((c) =>
            c.localName === 'extension' || c.localName === 'restriction'
          )
          if (extension) {
            node.children.push(...collectAttrs(extension, new Set(newVisited)))
            directElements(extension).forEach((childEl) => {
              node.children.push(buildNode(childEl, depth + 1, newVisited))
            })
            // Base type
            const base = stripPfx(extension.getAttribute('base') ?? '')
            if (base && !isPrimitive(base) && !newVisited.has(base)) {
              const baseCt = complexTypes.get(base)
              if (baseCt) {
                newVisited.add(base)
                node.children.push(...collectAttrs(baseCt, new Set(newVisited)))
                directElements(baseCt).forEach((childEl) => {
                  node.children.push(buildNode(childEl, depth + 1, newVisited))
                })
              }
            }
          }
        }
      }

      return node
    }

    // Processa elementi radice (figli diretti di xs:schema)
    return Array.from(doc.documentElement.children)
      .filter((c) => c.localName === 'element')
      .map((el) => buildNode(el, 0, new Set()))

  } catch { return [] }
}

// ─── Utilità di conversione ───────────────────────────────────────
// Ogni componente chiama parseXsd() e poi converte XsdNode nel suo tipo.
// Esempi di conversione in XmlTreeNode e JsonTreeNode sono nei rispettivi modal.