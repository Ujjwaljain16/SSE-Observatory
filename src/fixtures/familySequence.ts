/** F06 (a resume that skips ids, and its healthy twin) and F07 (a flood of tiny events). */
import { frame, numericId, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const contract = { sequence: { useSseId: true, policy: 'consecutive' as const } }
const payload = (i: number) => JSON.stringify({ n: i + 1 })

/**
 * The first connection sends half the events and ends (the client reconnects with Last-Event-ID). The second continues
 * after the cursor, jumping `skip` ids ahead when the server's history is too short to resume correctly.
 */
const resumable = (skip: number): Script => async (ctx) => {
    const first = ctx.lastEventId === ''
    const start = first ? 0 : ctx.from + skip
    const stopAfter = first ? Math.floor(ctx.n / 2) : ctx.n
    for (let i = start; i < stopAfter; i++) {
        if (!(await ctx.sleep(300))) return
        ctx.write(frame(numericId(i), 'tick', payload(i)))
    }
    if (!first) ctx.write('event: end\ndata: done\n\n')
}

const flood: Script = async (ctx) => {
    for (let i = ctx.from; i < ctx.n; i++) {
        ctx.write(frame(numericId(i), 'tick', payload(i)))
        // give the socket and the client a turn now and then, so the flood is many reads and not one
        if (i % 100 === 99) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    ctx.write('event: end\ndata: done\n\n')
}

const routes: FixtureRoute[] = [
    { id: 'f06-skips', family: 'F06', path: '/f06/skips', title: 'Resume skips ids', description: 'Half the events, a dropped connection, then a resume that jumps three ids past the cursor (a server history that is too short).', expectedFindings: ['resume.last-event-id:skipped'], forbiddenFindings: ['stall.silent', 'seq.integrity:gap'], healthyTwin: 'f06-resumes', defaultN: 8, profile: contract },
    { id: 'f06-resumes', family: 'F06', path: '/f06/resumes', title: 'Healthy: resume continues after the cursor', description: 'The same drop, resumed correctly.', expectedFindings: [], forbiddenFindings: ['*'], healthyTwin: null, defaultN: 8, profile: contract },
    { id: 'f07-flood', family: 'F07', path: '/f07/flood', title: 'Flood of tiny events', description: 'Thousands of small events with no pause. Nothing is wrong with the network; this is a load case for the client and the engine.', expectedFindings: [], forbiddenFindings: ['*'], healthyTwin: null, defaultN: 2000, profile: contract },
]

export const sequenceFamily: FixtureFamily = {
    routes,
    scripts: { '/f06/skips': resumable(3), '/f06/resumes': resumable(0), '/f07/flood': flood },
}
