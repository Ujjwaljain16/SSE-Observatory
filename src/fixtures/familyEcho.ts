/**
 * F08 echo: a server that gives back every credential it was sent. It exists for the canary sweep (plan E1): plant a secret in a request (an
 * Authorization header, a cookie, an API key, a `?token=` query value) and it comes back inside the stream, in the places a real server leaks
 * one: a nested `password` key in a payload, a `token` inside a list, a `key=value` in a debug comment, an event id, and a Set-Cookie response
 * header. Then every output of the tool can be searched for the value that was planted.
 *
 * It sends no fault of its own (apart from the token in the URL, which the credentials check reports), so its healthy twin is `h01`.
 */
import { frame, type FixtureFamily, type FixtureRoute, type Script } from './kit'

const header = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join(', ') : value ?? '')

const echo: Script = async (ctx) => {
    const auth = header(ctx.req.headers['authorization'])
    const cookie = header(ctx.req.headers['cookie'])
    const apiKey = header(ctx.req.headers['x-api-key'])
    const token = ctx.query.get('token') ?? ''
    const idToken = ctx.query.get('idtoken') ?? ''
    // a debug comment, as servers leave them
    ctx.write(`: debug api_key=${apiKey.replace(/\s+/g, '')} cookie=${cookie.replace(/\s+/g, '')}\n\n`)
    for (let i = ctx.from; i < ctx.n; i++) {
        if (!(await ctx.sleep(50))) return
        // the first event's id carries a token of its own, the way a session-scoped id can
        const id = i === 0 && idToken ? idToken : String(i + 1)
        const payload = { n: i + 1, user: { name: 'ada', password: auth }, items: [{ token, cookie }], apiKey }
        ctx.write(frame(id, 'tick', JSON.stringify(payload)))
    }
    ctx.write('event: end\ndata: done\n\n')
}

const routes: FixtureRoute[] = [
    {
        id: 'f08-echo', family: 'F08', path: '/f08/echo', title: 'Echoes the credentials it was sent',
        description: 'Gives back the Authorization header, the cookie, the API key and the ?token= value in its payloads and comment, ?idtoken= as an event id, and a Set-Cookie header.',
        expectedFindings: ['security.credentials-in-metadata:url'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01', defaultN: 3,
        testOnly: 'it exists to test redaction: it echoes whatever credentials the request carries, so a capture of it would be a capture of the request',
    },
]

export const echoFamily: FixtureFamily = { routes, scripts: { '/f08/echo': echo } }
