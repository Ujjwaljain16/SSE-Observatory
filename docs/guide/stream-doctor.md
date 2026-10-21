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

## Sections

The panel has three tabs. **Findings** is described above. **Sequence** and **Profile** are about the numbers in your events.

### Profile

Gaps and duplicates are only judged when you say which numbers count, because ids that merely look sequential prove
nothing (a server may legitimately send 104 and then 111). The profile is where you say it:

- **How the events are numbered**: the SSE `id:` field, or a JSON path into the event data such as `$.seq`; counted
  *one by one* (a skipped number is a loss) or *upwards* (jumps are fine, repeats and going backwards are not); optionally
  counted separately per `$.shard` or per event name (`$event`).
- **Delivery**: at least once (a replay after a reconnect is expected), exactly once (a repeat is an error), at most once.
- **Producer timestamp** and the timings you expect (time to the first event, longest silence, heartbeat interval).

**Fields in recent events** lists the numeric fields of the latest events (a counter that goes up by one is listed first,
then things that look like times), each with *Use as sequence* and *Use as timestamp*; the star pins a field to the top.
Picking one only fills the form. **Edit as JSON** shows the same profile as the file the command line reads with
`--profile`; a profile that cannot be used is refused with a plain message for every problem in it.

It is kept in this browser and applies to every stream. The rules use a saved profile at once (the recording is judged
again, and a silence that was going on keeps counting). The numbers themselves are read from each event as it is
recorded, so reconnect after declaring a sequence for events from then on to carry them.

### Sequence

Says how far the numbers can be trusted: **declared**, **not declared but the ids count up** (a hint, never a verdict), or
**not declared** (continuity cannot be verified). With a declared sequence it shows the latest numbers in order of
arrival as a strip, and a table of every place where a number did not follow on: after a gap (with the numbers that are
missing), seen before, or lower than before. The strip is a summary; the table is the same information as text.

This is the plain order of arrival. The Findings tab is the rule: it gives a late number a short window before calling it
lost, and treats events replayed after a reconnect as expected, so the two can differ, and that difference is worth looking at.
A gap that appears right before a stream goes quiet is shown in Findings once the window has passed, without waiting for another event.

## Exporting

**Export…** (top right of the panel) turns what the Doctor has seen into something you can keep or hand to someone. The
file is made in your browser and saved to your computer; nothing is uploaded.

| Choice | What it is |
|---|---|
| Report (Markdown, HTML or JSON) | the findings, the evidence and what could not be determined, ready for a ticket |
| Capture to share | the recording as an `.sse-capture` file with secrets replaced, which the [command line](/guide/cli) can analyse and replay |
| curl command | repeats the request; header and query values are not in it, only the names of the environment variables to set |
| Test scenario | a [scenario](/guide/cli-ci) made from this capture, so what you saw becomes a check that runs in CI |
| Smallest capture | removes records until nothing more can go and a finding you pick still shows: the minimal case to attach to a bug |
| Full local capture | the recording exactly as held in this tab. **It may contain secrets; keep it on your machine** |

Everything except the full local capture is made from a redacted copy. Redaction replaces secrets (tokens, keys, cookies,
credentials in URLs and comments) with numbered placeholders, the same number for the same value inside one file, and
the dialog shows how many values were replaced and by which rule before you save. It then scans the result for anything that
still looks secret. If that finds something, the download stays disabled until you tick that you have looked at the
preview and it is safe to share; the matches are listed by where they are, never by value. The scan is a check, not a
guarantee: read the preview of anything you are about to send.

What is recorded in the app is metadata (timings, sizes, comment text, response headers' names and values the browser
exposes), not the body of your events, so there is no event data in these files.

A stream that is still open has not ended at its last record. The export says when it stopped (`endT` in the capture's
footer), so a silence at the end, the thing a stall finding is about, is part of the file and reproduces when the
capture is analysed again or reduced to its smallest form.

## What it costs

- **Download.** The diagnostics (the engine and all of its rules, with their explanations) are a separate file fetched the
  first time a stream has records: about 28 KB with Brotli (32 KB gzip), including the panel. The main bundle grew by about 2.5 KB gzip.
  Nothing is fetched if you never connect.
- **CPU.** Feeding a record takes about 13 microseconds. After the first catch-up, a refresh with 100 new records on 50,000 held
  takes about 2 ms, and the once-a-second update about 1 ms.
- **Memory.** The recording that feeds it is capped at 8 MB per stream.

## Accessibility

The panel is built from native lists, headings and buttons. Each finding is a disclosure button that says whether it is
open (`aria-expanded`), the parts inside it are headings in order, evidence chips are buttons, severity is written out as
well as coloured, and a polite live region announces only changes of state (connection state and the counts of open
errors and warnings), not the once-a-second figures. Automated checks (axe, WCAG A and AA), a keyboard-only run and a check
of the accessibility tree run on every change. A run with a real screen reader has not been done, so treat it as untested
with one: reports are welcome.

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
