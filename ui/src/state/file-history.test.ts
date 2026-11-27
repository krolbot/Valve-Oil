import { describe, expect, it, vi } from 'vitest'

// files.ts reaches Moonraker through the printer's client; the resolver tests answer its calls from `moonraker`.
const moonraker = vi.hoisted(() => ({ jobs: [] as unknown[], files: {} as Record<string, { modified: number }> }))
vi.mock('./printer', () => ({
  client: {
    call: async (method: string, params: { filename?: string }) => {
      if (method === 'server.history.list') return { jobs: moonraker.jobs }
      const meta = moonraker.files[params.filename ?? '']
      if (method === 'server.files.metadata' && meta) return { filename: params.filename, size: 1, ...meta }
      throw new Error(`Metadata not available for <${params.filename}>`)
    },
  },
  afterKlipperAnswers: () => null,
  useConnected: () => false,
  usePrinter: () => 0,
}))
import { fileHistory, resolveGcodesFile, type HistoryJob } from './files'

const job = (job_id: string, filename: string, start_time: number, status: string): HistoryJob => ({ job_id, filename, start_time, status, end_time: start_time + 10, print_duration: 10, total_duration: 10, filament_used: 0 })

describe('fileHistory', () => {
  // Newest first, as server.history.list returns them with order desc.
  const jobs = [job('3', 'cube.gcode', 300, 'completed'), job('2', 'part.gcode', 200, 'cancelled'), job('1', 'part.gcode', 100, 'completed')]

  it('gives a file its last job and completed prints', () => {
    const of = fileHistory(jobs)
    expect(of('part.gcode', 50)).toEqual({ last: jobs[1], count: 1 })
    expect(of('cube.gcode', 250)?.last.job_id).toBe('3')
    expect(of('other.gcode', 0)).toBeUndefined()
  })

  it("leaves out jobs of an earlier file of the same name, deleted and uploaded again", () => {
    const of = fileHistory(jobs)
    expect(of('part.gcode', 250)).toBeUndefined()
    expect(of('part.gcode', 150)).toEqual({ last: jobs[1], count: 0 })
  })

  it('has nothing before history loads', () => {
    expect(fileHistory(null)('part.gcode', 0)).toBeUndefined()
  })
})

// QIDI's power-loss resume prints its copy of the file in ~/printer_data/.cache/, so print_stats.filename and the
// resumed job in history name that path, which Moonraker has no metadata for and won't serve.
describe('resolveGcodesFile', () => {
  const cache = (name: string) => `/home/qidi/printer_data/.cache/${name}`
  let rev = 0
  // Each case is its own files revision, so no lookup is reused from an earlier case.
  const resolve = (name: string, jobs: HistoryJob[], files: Record<string, { modified: number }>) => {
    Object.assign(moonraker, { jobs, files })
    return resolveGcodesFile(name, ++rev)
  }

  it('leaves a name in the gcodes root as it is', async () => {
    expect(await resolve('parts/cube.gcode', [], { 'parts/cube.gcode': { modified: 100 } })).toBe('parts/cube.gcode')
  })

  it("finds a resumed print's file through the job the power cut interrupted, in its folder", async () => {
    const jobs = [job('F', cache('Fillet3.gcode.3mf'), 900, 'in_progress'), job('E', 'parts/Fillet3.gcode.3mf', 500, 'interrupted')]
    expect(await resolve(cache('Fillet3.gcode.3mf'), jobs, { 'parts/Fillet3.gcode.3mf': { modified: 100 } })).toBe('parts/Fillet3.gcode.3mf')
  })

  it('falls back to the file of that name at the top of the gcodes root', async () => {
    expect(await resolve(cache('Fillet3.gcode.3mf'), [], { 'Fillet3.gcode.3mf': { modified: 100 } })).toBe('Fillet3.gcode.3mf')
  })

  it('takes an absolute path inside the gcodes root as relative to it', async () => {
    expect(await resolve('/home/qidi/printer_data/gcodes/parts/cube.gcode', [], { 'parts/cube.gcode': { modified: 100 } })).toBe('parts/cube.gcode')
  })

  it("doesn't pass off a file changed after the job started, or one that's gone, as the printed file", async () => {
    const jobs = [job('E', 'Fillet3.gcode.3mf', 500, 'interrupted')]
    expect(await resolve(cache('Fillet3.gcode.3mf'), jobs, { 'Fillet3.gcode.3mf': { modified: 700 } })).toBeNull()
    expect(await resolve(cache('Fillet3.gcode.3mf'), jobs, {})).toBeNull()
  })
})
