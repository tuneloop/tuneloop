import { describe, expect, it } from 'vitest'
import { dashboardUrl, isLoopback } from './serve'

describe('isLoopback', () => {
  it('treats the default bind and its aliases as loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.1.2.3')).toBe(true)
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
  })

  it('treats wildcard and external addresses as non-loopback', () => {
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('::')).toBe(false)
    expect(isLoopback('192.168.1.20')).toBe(false)
    expect(isLoopback('10.0.0.5')).toBe(false)
  })
})

describe('dashboardUrl', () => {
  it('uses localhost for the default loopback bind', () => {
    expect(dashboardUrl('127.0.0.1', 4319)).toBe('http://localhost:4319')
  })

  it('uses localhost for wildcard binds, which are not routable in a browser', () => {
    expect(dashboardUrl('0.0.0.0', 4319)).toBe('http://localhost:4319')
    expect(dashboardUrl('::', 4319)).toBe('http://localhost:4319')
  })

  it('uses the bound address for a specific interface', () => {
    expect(dashboardUrl('192.168.1.20', 8080)).toBe('http://192.168.1.20:8080')
  })

  it('brackets IPv6 addresses', () => {
    expect(dashboardUrl('::1', 4319)).toBe('http://[::1]:4319')
  })
})
