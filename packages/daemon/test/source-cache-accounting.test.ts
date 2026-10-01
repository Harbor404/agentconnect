import { describe, expect, it } from 'vitest'
import { openTestStore } from './store-support.js'

const reservation = (overrides: Record<string, unknown> = {}) => ({
  orgId: 'org-a',
  key: 'bundles/a.bundle',
  kind: 'bundle' as const,
  repositoryUrlHash: 'repo-hash',
  refHash: 'ref-hash',
  bytes: 60,
  createdAt: 1_000,
  expiresAt: 61_000,
  ...overrides
})

describe('source cache accounting contract', () => {
  it('admits exactly to the quota boundary and refuses the first byte over it', async () => {
    const store = await openTestStore()
    try {
      const first = await store.reserveSourceCacheObject(reservation({ bytes: 60 }), 100)
      const second = await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/b.bundle', bytes: 40, createdAt: 1_001 }),
        100
      )
      const refused = await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/c.bundle', bytes: 1, createdAt: 1_002 }),
        100
      )

      expect(first).toMatchObject({ orgId: 'org-a', key: 'bundles/a.bundle', state: 'pending', bytes: 60 })
      expect(second).toMatchObject({ key: 'bundles/b.bundle', state: 'pending', bytes: 40 })
      expect(refused).toBeUndefined()
      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 100 })
    } finally {
      await store.close()
    }
  })

  it('counts only unexpired pending reservations and releases expired rows on expiry', async () => {
    const store = await openTestStore()
    try {
      await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/expiring.bundle', bytes: 80, createdAt: 1_000, expiresAt: 1_500 }),
        100
      )
      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 80 })

      // expiresAt is an exclusive live boundary: exactly at the timestamp the reservation is reclaimable.
      const replacement = await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/replacement.bundle', bytes: 80, createdAt: 1_500, expiresAt: 2_000 }),
        100
      )
      expect(replacement).toMatchObject({ key: 'bundles/replacement.bundle', state: 'pending' })
      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 80 })

      const expired = await store.expireSourceCacheReservations('org-a', 1_500)
      expect(expired.map((row) => row.key)).toEqual(['bundles/expiring.bundle'])
      expect(await store.getSourceCacheObject('org-a', 'bundles/expiring.bundle')).toBeUndefined()
      expect(await store.getSourceCacheObject('org-a', 'bundles/replacement.bundle')).toMatchObject({
        state: 'pending'
      })
    } finally {
      await store.close()
    }
  })

  it('serializes concurrent reservations without exceeding the org quota', async () => {
    const store = await openTestStore()
    try {
      const attempts = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          store.reserveSourceCacheObject(
            reservation({
              key: `bundles/concurrent-${index}.bundle`,
              bytes: 30,
              createdAt: 2_000 + index,
              expiresAt: 20_000
            }),
            100
          )
        )
      )

      expect(attempts.filter(Boolean)).toHaveLength(3)
      expect((await store.sourceCacheUsage('org-a')).usedBytes).toBe(90)
    } finally {
      await store.close()
    }
  })

  it('commits pending rows and advances last-read independently', async () => {
    const store = await openTestStore()
    try {
      await store.reserveSourceCacheObject(reservation({ bytes: 25 }), 100)
      expect(await store.commitSourceCacheObject('org-a', 'bundles/a.bundle', 2_000)).toBe(true)
      expect(await store.getSourceCacheObject('org-a', 'bundles/a.bundle')).toMatchObject({
        state: 'committed',
        expiresAt: null,
        lastReadAt: null
      })

      expect(await store.markSourceCacheObjectRead('org-a', 'bundles/a.bundle', 2_100)).toBe(true)
      expect(await store.markSourceCacheObjectRead('org-a', 'bundles/a.bundle', 2_050)).toBe(false)
      expect(await store.getSourceCacheObject('org-a', 'bundles/a.bundle')).toMatchObject({ lastReadAt: 2_100 })

      // An expired reservation cannot be committed once its expiry has passed.
      await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/late.bundle', bytes: 10, createdAt: 3_000, expiresAt: 4_000 }),
        100
      )
      expect(await store.commitSourceCacheObject('org-a', 'bundles/late.bundle', 4_000)).toBe(false)
      expect(await store.getSourceCacheObject('org-a', 'bundles/late.bundle')).toMatchObject({ state: 'pending' })
    } finally {
      await store.close()
    }
  })

  it('keeps accounting isolated by org', async () => {
    const store = await openTestStore()
    try {
      await store.reserveSourceCacheObject(reservation({ orgId: 'org-a', bytes: 80 }), 100)
      const other = await store.reserveSourceCacheObject(
        reservation({ orgId: 'org-b', key: 'bundles/a.bundle', bytes: 80 }),
        100
      )
      expect(other).toMatchObject({ orgId: 'org-b', key: 'bundles/a.bundle', state: 'pending' })
      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 80 })
      expect(await store.sourceCacheUsage('org-b')).toMatchObject({ usedBytes: 80 })
    } finally {
      await store.close()
    }
  })

  it('rolls back a failed reservation without leaking quota', async () => {
    const store = await openTestStore()
    try {
      await store.reserveSourceCacheObject(reservation({ key: 'bundles/a.bundle', bytes: 40 }), 100)
      await expect(
        store.reserveSourceCacheObject(
          reservation({ key: 'bundles/a.bundle', bytes: 40, createdAt: 2_000, expiresAt: 30_000 }),
          100
        )
      ).rejects.toThrow()

      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 40 })
      const remaining = await store.reserveSourceCacheObject(
        reservation({ key: 'bundles/b.bundle', bytes: 60, createdAt: 2_001, expiresAt: 30_000 }),
        100
      )
      expect(remaining).toMatchObject({ key: 'bundles/b.bundle', state: 'pending' })
      expect(await store.sourceCacheUsage('org-a')).toMatchObject({ usedBytes: 100 })
    } finally {
      await store.close()
    }
  })
})
