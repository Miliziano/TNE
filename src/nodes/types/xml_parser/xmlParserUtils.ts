import type { XmlTreeNode, XmlParserField, XmlParserFlow } from './xmlParserTypes'
import { parseXsd, type XsdNode } from '../shared/xsdParser'

let _nodeCounter = 0
function newId(prefix = 'n') { return `${prefix}_${++_nodeCounter}_${Date.now()}` }

// ─── Inferisce tipo da valore stringa ────────────────────────────
function inferType(value: string): string {
  if (!value) return 'string'
  if (/^-?\d+$/.test(value.trim())) return 'integer'
  if (/^-?\d+\.\d+$/.test(value.trim())) return 'decimal'
  if (/^(true|false|0|1)$/i.test(value.trim())) return 'boolean'
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return 'date'
  return 'string'
}

// ─── XPath assoluto ───────────────────────────────────────────────
function buildXPath(parentXPath: string, name: string, isAttr = false): string {
  if (isAttr) return `${parentXPath}/@${name}`
  if (!parentXPath || parentXPath === '/') return `/${name}`
  return `${parentXPath}/${name}`
}

// ─── Analizza elemento XML ricorsivamente ────────────────────────
function parseElement(el: Element, parentXPath: string, depth = 0): XmlTreeNode {
  const name  = el.localName
  const xpath = buildXPath(parentXPath, name)
  const children: XmlTreeNode[] = []

  Array.from(el.attributes).forEach((attr) => {
    if (attr.name.startsWith('xmlns')) return
    children.push({
      id: newId('a'), name: `@${attr.name}`,
      xpath: `${xpath}/@${attr.name}`,
      nodeType: 'attribute', valueType: inferType(attr.value),
      isArray: false, isOptional: true, children: [],
    })
  })

  const childElements = Array.from(el.children)
  const nameCounts: Record<string, number> = {}
  childElements.forEach((c) => { nameCounts[c.localName] = (nameCounts[c.localName] ?? 0) + 1 })

  const seenChildren = new Set<string>()
  childElements.forEach((child) => {
    const cName = child.localName
    if (seenChildren.has(cName)) return
    seenChildren.add(cName)
    const childNode = parseElement(child, xpath, depth + 1)
    childNode.isArray = (nameCounts[cName] ?? 1) > 1
    children.push(childNode)
  })

  const textContent = el.textContent?.trim() ?? ''
  const valueType   = childElements.length === 0 ? inferType(textContent) : 'object'

  return {
    id: newId('e'), name, xpath,
    nodeType: 'element', valueType,
    isArray: false, isOptional: false,
    children, collapsed: depth > 1,
  }
}

// ─── Entry point: inferisce albero da XML ────────────────────────
export function inferTreeFromXml(xmlString: string): XmlTreeNode[] {
  const parser  = new DOMParser()
  const doc     = parser.parseFromString(xmlString, 'application/xml')
  const errNode = doc.querySelector('parsererror')
  if (errNode) throw new Error(errNode.textContent ?? 'XML non valido')
  return [parseElement(doc.documentElement, '')]
}

// ─── Inferisce albero da XSD — usa il parser condiviso ───────────
// XsdNode usa multiple/optional; XmlTreeNode usa isArray/isOptional/valueType.
function xsdNodeToTreeNode(n: XsdNode, depth: number): XmlTreeNode {
  return {
    id:        newId(n.kind === 'attribute' ? 'xa' : 'xe'),
    name:      n.kind === 'attribute' ? `@${n.name}` : n.name,
    xpath:     '',   // assegnato da assignXPaths
    nodeType:  n.kind === 'attribute' ? 'attribute' : 'element',
    valueType: n.children.length > 0 ? 'object' : 'string',
    isArray:   n.multiple,
    isOptional: n.optional,
    children:  n.children.map((c) => xsdNodeToTreeNode(c, depth + 1)),
    collapsed: depth > 1,
  }
}

function assignXPaths(nodes: XmlTreeNode[], parentXPath = ''): XmlTreeNode[] {
  return nodes.map((n) => {
    const isAttr = n.nodeType === 'attribute'
    const name   = isAttr ? n.name.replace('@', '') : n.name
    const xpath  = buildXPath(parentXPath, name, isAttr)
    const effectXpath = n.isArray ? `${xpath}[*]` : xpath
    return {
      ...n,
      xpath: effectXpath,
      children: assignXPaths(n.children, effectXpath),
    }
  })
}

export function inferTreeFromXsd(xsdString: string): XmlTreeNode[] {
  const xsdNodes = parseXsd(xsdString)
  if (xsdNodes.length === 0) throw new Error('XSD non valido o struttura non riconosciuta')
  const converted = xsdNodes.map((n) => xsdNodeToTreeNode(n, 0))
  return assignXPaths(converted)
}

// ─── Raccoglie tutte le foglie di un nodo (ricorsivo) ────────────
export function collectLeaves(
  node: XmlTreeNode,
  contextXPath: string,
  includeAttrs = true
): XmlParserField[] {
  const fields: XmlParserField[] = []

  function walk(n: XmlTreeNode) {
    const isLeaf = n.children.length === 0 && n.valueType !== 'object'
    const isAttr = n.nodeType === 'attribute'

    if (isAttr && !includeAttrs) return

    if (isLeaf || isAttr) {
      const relXPath = n.xpath.startsWith(contextXPath)
        ? n.xpath.slice(contextXPath.length).replace(/^\//, '') || '.'
        : n.xpath

      fields.push({
        id:          newId('lf'),
        name:        n.name.replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '_'),
        xpath:       relXPath,
        type:        n.valueType,
        transform:   'none',
        onMissing:   n.isOptional ? 'null' : 'null',
        isAttribute: isAttr,
      })
    } else {
      n.children.forEach(walk)
    }
  }

  if (node.children.length > 0) {
    node.children.forEach(walk)
  } else {
    walk(node)
  }

  return fields
}

// ─── Genera flussi automatici dai nodi figli della radice ────────
const FLOW_COLORS = [
  '#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#f97316',
  '#f472b6', '#84cc16', '#fb923c', '#e879f9', '#22d3ee',
]

export function generateFlowsFromTree(treeNodes: XmlTreeNode[]): XmlParserFlow[] {
  const flows: XmlParserFlow[] = []

  function processNode(node: XmlTreeNode, colorIdx: number): XmlParserFlow {
    const color  = FLOW_COLORS[colorIdx % FLOW_COLORS.length]
    const fields = collectLeaves(node, node.xpath)
    return {
      id:          newId('flow'),
      label:       node.name,
      color,
      xpath:       node.xpath,
      isRepeating: node.isArray,
      streaming:   false,
      fields,
    }
  }

  if (treeNodes.length === 0) return []

  const root = treeNodes[0]

  if (root.children.length === 0) {
    flows.push(processNode(root, 0))
    return flows
  }

  const candidates = root.children.filter((c) => c.children.length > 0 || c.isArray)

  if (candidates.length > 0) {
    candidates.forEach((child, idx) => flows.push(processNode(child, idx)))
  } else {
    flows.push(processNode(root, 0))
  }

  return flows
}

// ─── Genera un singolo flusso da un nodo selezionato ─────────────
export function generateFlowFromNode(node: XmlTreeNode, colorIdx = 0): XmlParserFlow {
  const color  = FLOW_COLORS[colorIdx % FLOW_COLORS.length]
  const fields = collectLeaves(node, node.xpath)
  return {
    id:          newId('flow'),
    label:       node.name,
    color,
    xpath:       node.xpath,
    isRepeating: node.isArray,
    streaming:   false,
    fields,
  }
}

// ─── Flatten dell'albero ──────────────────────────────────────────
export function flattenTree(nodes: XmlTreeNode[]): XmlTreeNode[] {
  const result: XmlTreeNode[] = []
  function walk(n: XmlTreeNode) { result.push(n); n.children.forEach(walk) }
  nodes.forEach(walk)
  return result
}

// ─── Nodi già mappati (per badge) ────────────────────────────────
export function getMappedXPaths(flows: XmlParserFlow[]): Map<string, { flowLabel: string; color: string }> {
  const map = new Map<string, { flowLabel: string; color: string }>()
  flows.forEach((flow) => {
    map.set(flow.xpath, { flowLabel: flow.label, color: flow.color })
    flow.fields.forEach((f) => {
      const absXPath = flow.xpath + '/' + f.xpath
      map.set(absXPath.replace('//', '/'), { flowLabel: flow.label, color: flow.color })
    })
  })
  return map
}