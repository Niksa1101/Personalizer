import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import { clearFailures, isLockedOut, recordFailure, resetRateLimiter } from './rate-limit'

// Every function takes an explicit `now`, so none of this needs fake timers.
const T0 = 1_700_000_000_000
const MINUTE = 60_000

beforeEach(() => {
  resetRateLimiter()
})

describe('login throttle', () => {
  it('is open with no recorded failures', () => {
    assert.equal(isLockedOut(T0), false)
  })

  it('locks on the fifth failure inside a minute', () => {
    for (let i = 0; i < 4; i++) recordFailure(T0 + i * 1000)
    assert.equal(isLockedOut(T0 + 4000), false, 'four failures must not lock')

    recordFailure(T0 + 5000)
    assert.equal(isLockedOut(T0 + 5000), true)
  })

  it('reopens once the oldest failure ages out of the 60s window', () => {
    for (let i = 0; i < 5; i++) recordFailure(T0 + i * 1000)
    assert.equal(isLockedOut(T0 + 5000), true)

    // 60.5s after the first failure only four remain inside the minute window,
    // and five is far below the 10-per-15-minutes tier.
    assert.equal(isLockedOut(T0 + MINUTE + 500), false)
  })

  it('locks at ten failures even when they never cluster into a minute', () => {
    // 90s apart, so the 5-per-minute tier can never be the cause.
    for (let i = 0; i < 10; i++) recordFailure(T0 + i * 90_000)
    assert.equal(isLockedOut(T0 + 9 * 90_000), true)
  })

  it('cannot have a lockout extended by attempts made while locked (D16)', () => {
    for (let i = 0; i < 5; i++) recordFailure(T0 + i * 1000)
    assert.equal(isLockedOut(T0 + 5000), true)

    // The route returns early without calling recordFailure() while locked, so
    // the window still decays from the original five. If it did not, a caller
    // hammering the endpoint could hold itself locked out forever.
    assert.equal(isLockedOut(T0 + MINUTE + 500), false)
  })

  it('clears on a successful login (D17)', () => {
    for (let i = 0; i < 5; i++) recordFailure(T0 + i * 1000)
    assert.equal(isLockedOut(T0 + 5000), true)

    clearFailures()
    assert.equal(isLockedOut(T0 + 5000), false)
  })

  it('exposes no per-caller key that a request header could spoof', async () => {
    // Regression guard. The limiter used to key on x-forwarded-for, which
    // nothing sets in this deployment and any caller can forge — a fresh header
    // value bought a fresh bucket and the tiers never fired.
    const mod = await import('./rate-limit')
    assert.equal('clientKey' in mod, false)
  })
})
