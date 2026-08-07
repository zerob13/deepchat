import { createHash } from 'crypto'

function normalizeForStableJson(value: unknown, preservePrototypeKeys: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item, preservePrototypeKeys))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>(
      (result, key) => {
        const nested = record[key]
        if (nested !== undefined) {
          result[key] = normalizeForStableJson(nested, preservePrototypeKeys)
        }
        return result
      },
      preservePrototypeKeys ? (Object.create(null) as Record<string, unknown>) : {}
    )
}

function assertJsonDataValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }

  if (!value || typeof value !== 'object') {
    throw new TypeError('Value contains a non-JSON type.')
  }
  if (ancestors.has(value)) {
    throw new TypeError('Value contains a circular reference.')
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError('Value contains a sparse array or non-index property.')
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Value contains a non-data array item.')
        }
        assertJsonDataValue(descriptor.value, ancestors)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Value contains a non-plain object.')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Value contains a symbol property.')
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Value contains a non-data property.')
      }
      assertJsonDataValue(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function assertJsonData(value: unknown): void {
  assertJsonDataValue(value, new Set())
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value, false))
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex')
}

// ViewManifest hashes keep the legacy object accumulator; journal identities need a
// null-prototype accumulator so JSON keys such as "__proto__" remain identity-bearing.
export function hashJsonData(value: unknown): string {
  assertJsonData(value)
  return createHash('sha256')
    .update(JSON.stringify(normalizeForStableJson(value, true)))
    .digest('hex')
}
