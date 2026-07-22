import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { loginUrlFor, safeNext } from './next-path'

describe('safeNext', () => {
  it('passes an ordinary internal path through untouched', () => {
    assert.equal(safeNext('/leads'), '/leads')
    assert.equal(safeNext('/leads?status=failed&batch=3'), '/leads?status=failed&batch=3')
  })

  it('rejects protocol-relative paths', () => {
    // `//evil.com` is an absolute URL to a browser, not a path.
    assert.equal(safeNext('//evil.com'), '/')
    assert.equal(safeNext('//evil.com/leads'), '/')
  })

  it('rejects a backslash-smuggled absolute URL', () => {
    // Browsers normalize `\` to `/`, so `/\evil.com` navigates off-origin.
    assert.equal(safeNext('/\\evil.com'), '/')
  })

  it('rejects anything that is not origin-relative', () => {
    assert.equal(safeNext('https://evil.com'), '/')
    assert.equal(safeNext('leads'), '/')
    assert.equal(safeNext(''), '/')
  })

  it('rejects control characters that could split a Location header', () => {
    assert.equal(safeNext('/leads\nSet-Cookie: pz_session=forged'), '/')
    assert.equal(safeNext('/leads\r\nLocation: https://evil.com'), '/')
  })

  it('falls back for a repeated or missing query parameter', () => {
    // `?next=/a&next=/b` parses to an array.
    assert.equal(safeNext(['/a', '/b']), '/')
    assert.equal(safeNext(undefined), '/')
    assert.equal(safeNext(null), '/')
  })
})

describe('loginUrlFor', () => {
  it('omits next when the destination is the default', () => {
    assert.equal(loginUrlFor('/'), '/login')
    assert.equal(loginUrlFor(undefined), '/login')
  })

  it('encodes a real destination', () => {
    assert.equal(loginUrlFor('/leads'), '/login?next=%2Fleads')
    assert.equal(
      loginUrlFor('/leads?status=failed'),
      '/login?next=%2Fleads%3Fstatus%3Dfailed',
    )
  })

  it('never carries an unsafe destination forward', () => {
    assert.equal(loginUrlFor('//evil.com'), '/login')
    assert.equal(loginUrlFor('https://evil.com'), '/login')
  })
})
