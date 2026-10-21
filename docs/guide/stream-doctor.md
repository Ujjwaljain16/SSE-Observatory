# Stream Doctor (in the app)

The **Doctor** button, in the toolbar above the events list (Monitor mode) and under the lanes (Multi-Stream), opens a
panel that says what looks wrong with the stream you are connected to, and shows the evidence. It runs the same
diagnostics as the [command line](/guide/cli) and the [test runner](/guide/cli-ci); the rules are described in
[Diagnostics](/technical/diagnostics).

Nothing is sent anywhere. The panel reads what the app recorded about the connection in this browser tab.

## What you see

**Health strip.** Live figures, refreshed once a second:

| Figure | Meaning |
|---|---|
| Connection | the current state, the attempt number and how long it has been in that state |
| Last byte / Last origin byte | when anything arrived, and when the origin (not a proxy) last spoke. A proxy keep-alive moves the first but never the second |
| Last proxy heartbeat | only shown when the SSE Observatory proxy is in the path |
| Last event | the age of the last complete event, and the count so far |
| Origin heartbeat | comment lines from the server, and how often they come |
| Reconnects | how many times the client had to reconnect |
| Page processing | how long events waited in the page before being processed (95th percentile) and the queue length |
| Recording | how many records are held and how much of the memory cap they use |

**Findings.** Most serious first. Each one opens into four separate parts, because they are different kinds of claim:

- **Observed**: what was measured. Each fact has evidence chips; a chip opens the raw record it came from.
- **Inferred, not measured**: what the facts suggest. Always worded "Likely: …", with a confidence and the other
  explanations that fit the same facts.
- **Check next**: the test that would tell those explanations apart, with a command to copy where there is one.
- **Limits**: what this check cannot know.

**What was checked.** Every rule is listed as *checked* or *not evaluated*. A rule is not evaluated when the recording has
nothing for it to look at (for example the page-processing rule before any event has been processed). "No findings" is
never shown as "healthy": it only means nothing the checks look for has appeared.

## The badge

The Doctor button carries a badge with the number of open errors, or of open warnings when there are no errors. The
diagnostics keep running while the panel is closed, so the badge appears without opening it.

## Several streams

In Multi-Stream each lane gets its own card in the lane's colour, the lane with the most serious open finding first.

## Good to know

- Silence is judged against the stream's own rhythm. A stream that sends nothing for a long time by design needs a
  declared cadence before "silent" means "stalled"; the finding says so when it cannot tell.
- A tab that was hidden for a while does not count the time away as a stall: the checks restart when the tab is visible again.
- The recording is bounded (8 MB per stream). When it has to give up detail it says what, in the strip and in the
  records it keeps; older detail goes first.
- Recording can be switched off for streams started afterwards with `localStorage.setItem('sse.recording', 'off')`. The
  viewer works as before; the Doctor then has nothing to diagnose.
- Browsers hide response headers from cross-origin pages unless the server exposes them. Checks that need them say "not
  evaluated" for such a stream, and work in full through the app's own proxy.
