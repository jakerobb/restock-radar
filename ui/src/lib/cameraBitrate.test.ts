import { derived } from '../test/fixtures'
import { cameraMbps } from './cameraBitrate'

const metric = (name: string, value: number) => ({ name, value, unit: '', at_least: false, raw: '' })
const cam = (...m: [string, number][]) => derived({ metrics: m.map(([n, v]) => metric(n, v)) })

describe('cameraMbps', () => {
  it('takes the rate of the resolution class', () => {
    expect([2, 4, 8].map((mp) => cameraMbps(cam(['camera_megapixels', mp])))).toEqual([3, 6, 12])
  })
  it('scales up past a 4K sensor, and by the number of sensors', () => {
    expect(cameraMbps(cam(['camera_megapixels', 16]))).toBeCloseTo(12 * (16 / 8.3))
    expect(cameraMbps(cam(['camera_megapixels', 8], ['camera_sensors', 4]))).toBe(48)
  })
  it('uses a bitrate the camera is given over the class’s, and is null with no resolution', () => {
    expect(cameraMbps(cam(['camera_megapixels', 8], ['camera_bitrate_mbps', 20]))).toBe(20)
    expect(cameraMbps(cam())).toBeNull()
  })
})
