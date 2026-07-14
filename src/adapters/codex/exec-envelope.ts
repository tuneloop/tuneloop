import { parse, type Node } from 'acorn'

/** One real tool invocation statically recovered from a unified Codex `exec` body. */
export interface ExecOperation {
  name: string
  input: unknown
  /** False when the argument is dynamic and preserved only as source text. */
  resolved: boolean
  /** Source offset, used to keep nested calls in their original order. */
  start: number
}

export interface ExecEnvelope {
  operations: ExecOperation[]
  /** True only for `for (const x of <Promise.all result>) text(x...)`. */
  emitsResultsInOrder: boolean
}

/* Acorn's precise union is intentionally hidden behind this local traversal type. */
type RawNode = Node & Record<string, unknown>

const UNKNOWN = Symbol('unknown')

/**
 * Parse (never execute) a unified `exec` JavaScript body and recover calls of the
 * form `tools.<name>(arg)`. The evaluator is deliberately JSON-only: literals,
 * arrays, objects, and identifiers bound to statically-known const values. Any
 * dynamic expression stays opaque instead of running transcript-controlled code.
 */
export function extractExecOperations(source: string): ExecOperation[] {
  return extractExecEnvelope(source).operations
}

export function extractExecEnvelope(source: string): ExecEnvelope {
  let program: Node
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    })
  } catch {
    return { operations: [], emitsResultsInOrder: false }
  }

  const env = new Map<string, unknown>()
  walk(program as RawNode, (node) => {
    if (node.type !== 'VariableDeclarator') return
    const id = node.id as RawNode | undefined
    const init = node.init as RawNode | null | undefined
    if (id?.type !== 'Identifier' || !init) return
    const value = staticValue(init, env)
    if (value !== UNKNOWN) env.set(String(id.name), value)
  })

  const operations: ExecOperation[] = []
  walk(program as RawNode, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as RawNode | undefined
    const name = toolMethod(callee)
    if (!name) return
    const args = Array.isArray(node.arguments) ? (node.arguments as RawNode[]) : []
    const first = args[0]
    const value = first ? staticValue(first, env) : {}
    operations.push({
      name,
      input: value === UNKNOWN ? { _raw: first ? source.slice(first.start, first.end) : '' } : value,
      resolved: value !== UNKNOWN,
      start: node.start,
    })
  })
  operations.sort((a, b) => a.start - b.start)
  return { operations, emitsResultsInOrder: orderedPromiseEmission(program as RawNode, operations) }
}

function orderedPromiseEmission(program: RawNode, operations: ExecOperation[]): boolean {
  if (operations.length < 2) return false
  const promiseRanges = new Map<string, { start: number; end: number }>()
  walk(program, (node) => {
    if (node.type !== 'VariableDeclarator') return
    const id = node.id as RawNode | undefined
    let init = node.init as RawNode | null | undefined
    if (id?.type !== 'Identifier' || !init) return
    if (init.type === 'AwaitExpression') init = init.argument as RawNode
    if (!isPromiseAll(init)) return
    promiseRanges.set(String(id.name), { start: init.start, end: init.end })
  })

  let ordered = false
  walk(program, (node) => {
    if (ordered || node.type !== 'ForOfStatement') return
    const right = node.right as RawNode | undefined
    const left = node.left as RawNode | undefined
    if (right?.type !== 'Identifier' || left?.type !== 'VariableDeclaration') return
    const range = promiseRanges.get(String(right.name))
    const declaration = (left.declarations as RawNode[] | undefined)?.[0]
    const item = declaration?.id as RawNode | undefined
    if (!range || item?.type !== 'Identifier') return
    if (!operations.every((op) => op.start >= range.start && op.start <= range.end)) return
    const body = node.body as RawNode | undefined
    if (body && containsTextEmission(body, String(item.name))) ordered = true
  })
  return ordered
}

function isPromiseAll(node: RawNode): boolean {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee as RawNode | undefined
  const object = callee?.object as RawNode | undefined
  const property = callee?.property as RawNode | undefined
  return callee?.type === 'MemberExpression' && object?.type === 'Identifier' && object.name === 'Promise' && property?.type === 'Identifier' && property.name === 'all'
}

function containsTextEmission(body: RawNode, item: string): boolean {
  let found = false
  walk(body, (node) => {
    if (found || node.type !== 'CallExpression') return
    const callee = node.callee as RawNode | undefined
    if (callee?.type !== 'Identifier' || callee.name !== 'text') return
    const first = (node.arguments as RawNode[] | undefined)?.[0]
    if (!first) return
    walk(first, (part) => {
      if (part.type === 'Identifier' && part.name === item) found = true
    })
  })
  return found
}

function toolMethod(callee: RawNode | undefined): string | null {
  if (!callee || callee.type !== 'MemberExpression') return null
  const object = callee.object as RawNode | undefined
  const property = callee.property as RawNode | undefined
  if (object?.type !== 'Identifier' || object.name !== 'tools' || !property) return null
  if (!callee.computed && property.type === 'Identifier') return String(property.name)
  if (callee.computed && property.type === 'Literal' && typeof property.value === 'string') return property.value
  return null
}

function staticValue(node: RawNode, env: Map<string, unknown>): unknown | typeof UNKNOWN {
  switch (node.type) {
    case 'Literal': {
      const value = node.value
      return typeof value === 'bigint' || value instanceof RegExp ? UNKNOWN : value
    }
    case 'Identifier':
      return env.has(String(node.name)) ? env.get(String(node.name)) : UNKNOWN
    case 'TemplateLiteral': {
      const expressions = node.expressions as RawNode[] | undefined
      if (expressions?.length) return UNKNOWN
      const quasis = node.quasis as Array<RawNode & { value?: { cooked?: string | null } }> | undefined
      return (quasis ?? []).map((q) => q.value?.cooked ?? '').join('')
    }
    case 'ArrayExpression': {
      const out: unknown[] = []
      for (const el of (node.elements as Array<RawNode | null> | undefined) ?? []) {
        if (!el) { out.push(null); continue }
        const value = staticValue(el, env)
        if (value === UNKNOWN) return UNKNOWN
        out.push(value)
      }
      return out
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {}
      for (const prop of (node.properties as RawNode[] | undefined) ?? []) {
        if (prop.type === 'SpreadElement') {
          const spread = staticValue(prop.argument as RawNode, env)
          if (spread === UNKNOWN || !spread || typeof spread !== 'object' || Array.isArray(spread)) return UNKNOWN
          Object.assign(out, spread)
          continue
        }
        if (prop.type !== 'Property' || prop.kind !== 'init') return UNKNOWN
        const keyNode = prop.key as RawNode
        const key =
          !prop.computed && keyNode.type === 'Identifier'
            ? String(keyNode.name)
            : keyNode.type === 'Literal' && (typeof keyNode.value === 'string' || typeof keyNode.value === 'number')
              ? String(keyNode.value)
              : null
        if (key == null) return UNKNOWN
        const value = staticValue(prop.value as RawNode, env)
        if (value === UNKNOWN) return UNKNOWN
        out[key] = value
      }
      return out
    }
    case 'UnaryExpression': {
      const value = staticValue(node.argument as RawNode, env)
      if (value === UNKNOWN) return UNKNOWN
      if (node.operator === '-' && typeof value === 'number') return -value
      if (node.operator === '+' && typeof value === 'number') return value
      if (node.operator === '!') return !value
      return UNKNOWN
    }
    default:
      return UNKNOWN
  }
}

function walk(node: RawNode, visit: (node: RawNode) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit)
    } else if (isNode(value)) {
      walk(value, visit)
    }
  }
}

function isNode(value: unknown): value is RawNode {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}
