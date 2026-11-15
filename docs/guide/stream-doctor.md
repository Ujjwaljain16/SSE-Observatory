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

The panel has seven tabs. **Findings** is described above. **Request**, **Flow**, **Timeline** and **Captures** are about the connection and about recordings you keep. **Sequence** and **Profile** are about the numbers in your events.

### Request

One entry per connection attempt, newest first, each with what was asked and what came back:

- **Request**: the method and the URL as recorded (credentials and query values are already replaced), the names of the request headers that were sent, and the `Last-Event-ID` the attempt resumed from. Header *values* are never recorded, only names.
- **Response**: the status, the content type, whether there was a redirect, and the response headers the Doctor keeps (the ones that explain buffering, caching and proxy behaviour: `Cache-Control`, `Content-Encoding`, `Via`, `X-Accel-Buffering`, the proxy's own `X-SSE-*` tags and a few more). A cross-origin response only shows the headers its server exposes with CORS, so a short list can mean that.
- **Timing**: until the response headers, until the first bytes, until the first event, and how long the attempt lasted (so far, if it is still open), as differences of record times, the same figures the checks use.

### Flow

The newest 200 events as they arrived, and how long the page took to process them, drawn on one time axis in the recording's own clock:

- **Arrived**: a tick for each event reaching the client from the network.
- **Page**: a bar for each stretch of the page's own processing, from when the oldest event of that batch arrived until it was handled. A teal bar waited 250 ms or less; an amber one with an outline waited longer.
- **Queued**: how many events were still waiting after each batch.
- A dashed red line marks where the connection was made again.

Under the drawing, **Where the time went** says in plain sentences what was measured: how many events, how fast, the time between them (middle, slowest 5%, worst), how many processing batches, how long the oldest event of a batch waited (the same three figures), the share of slow batches, and, only when the wait is well over the usual time between events, that the page is processing more slowly than events arrive. A table lists the five slowest batches.

**What this does not show**, and says so on the page: when the producer created or wrote each event, how long one sat in a proxy, and how long *parsing* took. The page reports its processing in batches, so a batch's wait is the wait of its oldest event, an upper bound for the rest; and parsing is part of that wait, not separated from it (the `npm run bench` script measures the cost of the engine and the recorder on their own).

### Timeline

One row per connection attempt: how long it lived, each event as a tick, each comment line as a dot (filled from the origin,
hollow from the proxy), and a dashed line for the wait before the next attempt. The table under it says the same in words:
status and how long the headers took, time to the first event, the longest wait between byte arrivals, why it ended, the
`Last-Event-ID` it resumed from, and how long the client waited (and what the server's `retry:` asked for). That is the
place to check that a reconnect sent the id you expect.

**Bookmarks** mark a moment (a label and the time) and show on the timeline. They stay in this browser with the recording
and are copied when you save the recording to the library; they are not part of an exported file.

### Captures

A library of recordings kept in this browser (up to 20, 20 MB each, **not redacted**; share only through Export):

- **Save this recording** keeps the recording as it is now, with the profile and its bookmarks.
- **Open a file** reads an `.sse-capture` (from the command line or a teammate) or an older `.sse-record`; a file that is
  empty, not a capture, over the size limit or damaged is refused or read as far as it goes, with the reason. An older
  recording has event times only, so checks that need more say *not evaluated*. A file whose hash does not match is
  flagged as changed after it was written. A file whose records repeat a `seq`, whose `seq` goes down or whose `t` goes
  backwards is refused with the same message the command line prints (what is wrong and at which line), not opened as
  if it were healthy.
- **Analyse** runs the same checks on a saved or opened capture and lists its findings and what could not be evaluated.
- **Compare** two captures (tick both) lists where their behaviour differs. Which layer caused a difference cannot be told from two recordings alone, and the page says so.

### From a finding to the event, and to a replay

An evidence chip opens the raw record behind a claim. When the record is an event, **Show this event in the list** scrolls
the events list to it and marks it. If it is gone (the list keeps the latest 1000) or a filter hides it, the Doctor says
so instead of doing nothing.

In **Export**, a capture to share or the smallest capture can be played back with **Replay in Mock mode**: the capture
goes to the app's own mock server and the viewer connects to the replay. The app records what happened on the wire, not what
events said, so each body is a placeholder of the original size (carrying only the numbers your profile reads); the
timing, ids, event names and reconnects are the recording's. The Doctor says it is a replay. The command line makes the
same placeholder copy: `sse-doctor replay <capture>` replays the downloaded file and says it is a synthetic replay, not
a byte-exact one. The mock server is on in
development and off on a public deployment unless it was enabled for it.

### Privacy and retention

At the bottom of the Captures tab: what is kept where (the live recording in this tab's memory, bounded to 8 MB per stream; saved captures in this browser's storage, not redacted; your profile and redaction rules in local storage), and the controls over it.

- **Keep a copy of the recording automatically** (the *flight recorder*, off until you turn it on): when the Doctor first reports an **error**, and when you add a **bookmark**, a copy of the recording is saved to Captures as "Flight recorder: ...", so what led up to a problem is not lost when the bounded recording moves on or the tab closes. At most 3 per recording and 8 per visit, a pause of 15 s between copies, and one copy covers several findings that open together. A full library stops it (the Doctor says so) and it deletes nothing to make room. Each finding gets one attempt per recording, so a finding that stays open does not make a copy every second. The copies are ordinary saved captures: in this browser only, **not redacted**, listed, compared, exported and deleted like any other, and covered by the retention setting below. That is why it is off by default.
- **Record what the Doctor reads**: turn it off to keep nothing for diagnosis. The viewer works as before and the Doctor says recording is off. It applies to streams started after the change.
- **Delete saved captures after** never, 1, 7, 30 or 90 days, counted from when a capture was saved. It is checked when the app starts and when you change it, and a capture's bookmarks go with it.
- **Delete all saved captures** asks first, then removes every saved capture and bookmark.

### Failure lab

At the bottom of the Captures tab, **Failure lab** holds the built-in test streams: each a known fault (a wrong content type, a stream that goes silent, one that buffers, a reconnect that skips events, a payload that changes format) with its healthy twin. **Run the Doctor** reads the stream's recording with the app's own thresholds and shows what it found next to what the stream's author said it must: each expected finding with a tick or a cross, and each "must not appear" the same way. **Show its healthy twin** does the same for the stream that behaves, and **Save to my captures** puts the recording in your library so you can compare it with another.

It needs no server: the recordings are static files that ship with the app (`public/lab`), fetched when you open the lab. A test (`labCaptures.test.ts`) re-reads every one with the current rules and fails if any no longer shows what it should, so the lab cannot drift from what the Doctor does; if a rule changes, rebuild it with `npm run lab:build` (about two minutes: it records each fixture, mostly at a quarter of real speed and the detectors that need real-time gaps at full speed, and keeps a capture only when the Doctor meets the fixture's expectations under the default thresholds).

Some fixtures are **not** in the lab, and the lab lists them with the reason: the ones that need something a plain recording does not have (the slow page consumer needs the page's own samples, one fault needs a token in the request, one needs a stall to be judged without a rhythm to compare with) and the ones too large to ship (the flood of 2,000 events, the cap test). Nothing is shown as working that does not.

### Saved filters

In the query box, **Save this filter** keeps an expression under a name (up to 30, in this browser); a click applies it.

### Profile

Gaps and duplicates are only judged when you say which numbers count, because ids that merely look sequential prove
nothing (a server may legitimately send 104 and then 111). The profile is where you say it:

- **How the events are numbered**: the SSE `id:` field, or a JSON path into the event data such as `$.seq`; counted
  *one by one* (a skipped number is a loss) or *upwards* (jumps are fine, repeats and going backwards are not); optionally
  counted separately per `$.shard` or per event name (`$event`).
- **Delivery**: at least once (a replay after a reconnect is expected), exactly once (a repeat is an error), at most once.
- **Producer timestamp** and the timings you expect (time to the first event, longest silence, heartbeat interval).
- **How to show the events** (optional): a [display mapping](/guide/viewing-events#display-mapping) that puts a stream's own format into the list.

**Fields in recent events** lists the numeric fields of the latest events (a counter that goes up by one is listed first,
then things that look like times), each with *Use as sequence* and *Use as timestamp*; the star pins a field to the top of the list and [follows it in Stats](/guide/viewing-events#followed-fields).
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
| For an issue or pull request | a short body to paste: the verdict, the findings in a table, what was observed for the worst few, how to reproduce, and the full report folded away. Nothing is posted; you paste it. [Details](/guide/cli#team-reports) |
| Capture to share | the recording as an `.sse-capture` file with secrets replaced, which the [command line](/guide/cli) can analyse and replay (a synthetic replay: ids, names, order, timing and body sizes are the recording's, the bodies are placeholders, see [Replaying a capture from the app](/guide/cli#replaying-a-capture-from-the-app-a-synthetic-replay)) |
| curl command | repeats the request; header and query values are not in it, only the names of the environment variables to set |
| Test scenario | a [scenario](/guide/cli-ci) made from this capture, so what you saw becomes a check that runs in CI |
| Smallest capture | removes records until nothing more can go and a finding you pick still shows: the minimal case to attach to a bug |
| Full local capture | the recording exactly as held in this tab. **It may contain secrets; keep it on your machine** |

Everything except the full local capture is made from a redacted copy, with the built-in rules plus any [rules of your own](/guide/redaction-policy) from **Redaction rules** in the dialog (saved in this browser). Redaction replaces secrets (tokens, keys, cookies,
credentials in URLs and comments) with numbered placeholders, the same number for the same value inside one file, and
the dialog shows how many values were replaced and by which rule before you save. It then scans the result for anything that
still looks secret. If that finds something, the download stays disabled until you tick that you have looked at the
preview and it is safe to share; the matches are listed by where they are, never by value. The scan is a check, not a
guarantee: read the preview of anything you are about to send.

What is recorded in the app is metadata (timings, sizes, comment text, response headers' names and values the browser
exposes) and the *shape* of each JSON payload (its field names and kinds, never a value), not the body of your events, so there is no event data in these files. Switch the shapes off in the Privacy panel if field names are sensitive.

A stream that is still open has not ended at its last record. The export says when it stopped (`endT` in the capture's
footer), so a silence at the end, the thing a stall finding is about, is part of the file and reproduces when the
capture is analysed again or reduced to its smallest form.

## What it costs

- **Download.** The diagnostics (the engine and all of its rules, with their explanations) are a separate file fetched the
  first time a stream has records: about 28 KB with Brotli (32 KB gzip), including the panel. The main bundle grew by about 2.5 KB gzip.
  Nothing is fetched if you never connect.
- **CPU.** Feeding a record takes about 13 microseconds. Keeping the shape of each JSON payload (for the schema drift check) costs the recorder, per event, about 2 microseconds for a small payload, 8 for 700 bytes and 19 for 2 KB (parsing and describing it; Node micro-benchmark, not measured in a browser), and 4 KB is the limit, so at 500 events a second the worst case is about 2% of one core, in the worker. The check itself adds under 1 microsecond per record. After the first catch-up, a refresh with 100 new records on 50,000 held
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
