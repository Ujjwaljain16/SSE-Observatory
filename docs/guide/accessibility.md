# Accessibility

**No screen reader was used in testing this app.** Everything below that says something is announced describes what the page is built to announce (roles, live regions, names) and what automated checks and a read of the browser's accessibility tree confirm. Whether it sounds right, in the right order, to a person using NVDA, JAWS, VoiceOver or TalkBack has not been tried. Treat the app as untested with a screen reader. The checklist at the end is for the person who does the testing; if you run it, please [report what you hear](https://github.com/Ujjwaljain16/SSE-Observatory/issues).

## What the automated checks cover

The accessibility audit (`e2e/a11y.audit.spec.ts`) walks every screen and state of the app in a real Chrome, in the light and the dark theme, at a desktop width (1360 px) and a phone width (360 px). In each state it runs:

- **axe-core** with the WCAG 2.0, 2.1 and 2.2 level A and AA rules. No rule is switched off and no part of the page is left out of a scan.
- **The browser's own accessibility tree.** Every button, link, field, switch, tab, dialog and tab list that is exposed has a name, and no form field takes its only name from its placeholder (a placeholder is gone as soon as something is typed).
- **Keyboard focus**, by pressing Tab through the page (or through a dialog): there is a visible indicator on every stop, the order follows the visual order within each region, no tab index is positive, and nothing fixed to the screen (the timeline strip, the playback bar) covers the element that has focus.
- **Contrast that axe cannot decide.** axe reports text on a gradient, text under another element, single characters, empty fields and SVG text as "incomplete". The audit works these out from the computed colours (against every colour of a gradient, taking the worst) and fails on any below 4.5:1 (3:1 for large text). What it cannot work out is listed in "What a person should still check" below.

The screens and states walked, each in both themes and both widths:

- **Monitor:** the landing page with nothing connected; the save-profile form and a saved profile; a connected stream with events flowing (the events list and the JSON, CSV and Record export buttons); the Stats, Schema, Patterns (no rule, the add-rule form, a rule added) and Interceptors (one added) panels; a filter that matches nothing.
- **Multi-Stream:** no lanes; two lanes added; two lanes live; a lane whose connect failed; the per-lane Doctor with the fleet strip, its per-lane table, and the shared profile editor.
- **Mock Server:** nothing loaded; a recording loaded; a file that could not be read.
- **Doctor, connected:** a finding open (what was observed, what is inferred, limits); a finding with an evidence chip opened; a finding collapsed; "What was checked"; each of the seven tabs (Findings, Request, Flow, Timeline, Sequence, Captures, Profile); the timeline with the bookmark form filled and a bookmark added; the Failure lab list, a result, the healthy twin and the notice after saving; the profile editor with its JSON editor and a validation error.
- **Doctor, export:** the export dialog with each of its nine kinds selected, the residual-secrets warning shown, the "not redacted" note for the local capture, and the warning acknowledged.
- **Dialogs:** the copy warning for a raw value.
- **Errors and empty states:** a connect refused with HTTP 403 (an alert); a retrying HTTP 502 (a status with the countdown); the empty Doctor, with the Failure lab opened and a result shown, and its profile editor.

Further tests that are not tied to one state:

- **Keyboard only:** connect, open the Doctor, open a finding with Enter and Space, open its evidence, use the tab list with the arrow keys, Home and End, and open the export dialog, without a pointer.
- **Modals:** the export dialog and the copy warning keep Tab and Shift+Tab inside, close on Escape, and give focus back to the button that opened them; the save-profile popover closes on Escape and gives focus back to its button.
- **Reduced motion:** with the preference on, no element is left with an animation or a transition longer than a blink, in the landing page, a retry, a connected stream, the open Doctor and the export dialog. A second test checks the same page does animate without the preference, so the check is not empty.
- **Text at 200%:** at a 680 px viewport (half of 1360, the same layout as 200% browser zoom), nothing in the Doctor panel (every tab, a finding with its evidence open) or in the export dialog is cut off, overlaps other text, or makes the page scroll sideways.
- **Live regions:** the connection status is a polite status that exists before it changes; a failure that ends the attempt is an alert; every live region on the Doctor page is a polite status or an alert, never an assertive one by accident; the Doctor's region says the state of the connection and the counts of open errors and warnings, not the once-a-second figures; copying a raw value and running a lab stream are announced in words.
- **Contrast of status text** in both themes: Disconnected, Connected, Retrying, the connection error, the health strip, the severity of a finding and the page title (which is painted by a gradient).

Run it with `npx playwright test e2e/a11y.audit.spec.ts` (Chromium). It writes what it saw to `test-results/a11y-audit/`.

## Keyboard map

| To do this | Press |
| --- | --- |
| Move between controls | Tab and Shift+Tab. Tab lists, tables and charts that can scroll sideways are keyboard-focusable boxes: when one has focus, the arrow keys scroll it |
| Press a button, open a finding, open an evidence chip, expand "What was checked" | Enter or Space |
| Connect | Enter in the address field, or Tab to Connect and press Enter |
| Move between the Doctor's tabs | Left and Right arrow (the last wraps to the first), Home and End. The tab list is one tab stop: Tab leaves it for the panel |
| Turn the proxy switch on or off | Space |
| Step through the recorded events on the timeline strip at the bottom of the monitor | Tab to it; Left goes to an older event, Right to a newer one, Home to the oldest, End to the newest. The Previous Event and Next Event buttons do the same |
| Close a dialog (export, copy warning), or the save-profile form | Escape. Focus goes back to the button that opened it. The save-profile form also closes when Tab leaves it, because it floats over the controls after it |
| Delete a saved profile | Press its delete button twice (the first press asks, "Delete?"; the question lapses after four seconds) |

In a dialog, Tab and Shift+Tab stay inside it. The copy warning opens with focus on **Cancel**, the safe choice.

## What is announced, and when

This is what the page is built to put into live regions. It is checked by the tests above as markup and as text; it is not checked as speech.

| When | What a screen reader should be told | How |
| --- | --- | --- |
| A connection is made, or ends | "Connecting...", "Connected to" and the host name, "Disconnected" | A polite status region that is in the page from the start |
| A connect fails for good (a refused address, HTTP 401, 403, 404, the retries used up) | The error text, for example "HTTP 403 Forbidden", at once | An alert |
| The connection is lost and will be retried | "Connection lost (...). Retrying (attempt N)", once for each attempt. The seconds of the countdown are drawn but hidden from assistive technology, so the countdown is not read every second | The same polite status |
| The Doctor's state changes | "Connection open. 0 errors, 1 warning open." Only when the connection state or the counts of open errors or warnings change, never for the figures that change every second | A polite status inside the Doctor panel |
| A finding appears while the Doctor is closed | The Doctor button's name includes the count: "Doctor 1 open warning" | The button's name (not a live region) |
| A finding appears while the Doctor is open | The summary line ("1 open finding: 0 errors, 1 warning, 0 notes") and the status above. The new finding is **not** read out by itself | Text and the status; see the limits below |
| A lane's connect fails in Multi-Stream | The error text | An alert in the lane |
| A lab stream is run in the Failure lab | "The Doctor ran on f04-silent: it found what this stream was built to show, with 1 finding. The result is below the list." | A polite status. Focus stays on the button |
| A lab capture is saved | "Saved ..." | A polite status |
| A raw value is copied from an event | "Copied the raw value to the clipboard." | A polite status. The button's label also changes to "Copied!" |
| A command is copied from a finding | "Copied the command to the clipboard." | A polite status |
| A dialog opens | Its title, and for the copy warning its warning text | `role="dialog"` or `role="alertdialog"` with a title (and description); focus moves into it |
| An export finds something that may still be secret | "N things may still be secret after redaction ..." | An alert inside the export dialog |

## Known limits

- **No screen reader has been used.** Names, roles and live regions are checked; the spoken result, its order and its wording are not.
- **A new finding is not read out by itself** while the Doctor is open. A screen reader hears the Doctor's status ("... 1 warning open") and can move to the Findings list. This is deliberate: a stream can raise findings faster than they can be listened to.
- **The events list is a live log** with a new row at the top about as often as the stream sends one. It is not a live region (it would never stop talking). A screen reader reaches the rows by moving through the page; a very busy stream moves rows under the cursor.
- **Pointer and keyboard only; no touch gestures are specified.** On a phone the target size of every control is at least 24 by 24 CSS pixels (checked), and the layout works at 360 px, but it has not been used on a phone with VoiceOver or TalkBack.
- **The page background drifts.** In the dark theme the background gradient shifts slowly (a 20 second cycle) unless the reduced-motion preference is on; there is no control on the page to pause it. All text on it is checked against every colour of the gradient, but WCAG 2.2.2 (pause, stop, hide) asks for a control for moving content that lasts more than five seconds, and this one is not offered. It is not a fix that was made.
- **The charts** (the Doctor's flow and timeline) are described in a sentence, with the figures in a table beside them. The sentence is read; the drawing is not navigable. The strip along the bottom of the monitor is a slider you can move with the keyboard (below), but what the coloured bars mean is only in the picture.
- **Browsers other than Chrome** were not part of this audit. The rest of the browser suite also runs in Firefox and WebKit in CI, as an informational job that does not pass yet; the audit does not run there.
- Colour alone never carries a severity: it is written as a word (Error, Warning, Note) and an icon that is hidden from assistive technology.

## What a person should still check

axe reports a result as "incomplete" when it cannot decide. The audit settles the colour-contrast ones itself; what is left, and what to look at:

- **Colour contrast it could not work out**: text over a picture or over something whose colour is not in the page's styles. By eye: can you read it in both themes?
- **Focus indicator**: the audit checks that the focused element's style changes. By eye: is the change visible enough to find in a busy page, for example on the event rows and the white-on-colour buttons?
- **Reading order of the page** for someone who navigates by headings and landmarks. The page has one main landmark and a heading structure from the title down; the order in which things are read is for a person to judge.

## Manual screen reader checklist

Do not tick a box on what the page should say: tick it on what you heard. Write down anything that differs, with the screen reader, its version and the browser.

Test with each of:

| Platform | Screen reader and browser |
| --- | --- |
| Windows | NVDA with Firefox; NVDA with Chrome (JAWS if you have it) |
| macOS | VoiceOver with Safari |
| iOS | VoiceOver with Safari |
| Android | TalkBack with Chrome |

Set up: serve the test streams with `npm run doctor -- fixtures serve` (or any stream you control) and open the app. Use a bearer token field and an address you can change. For the mobile screen readers, open the hosted app and use a public stream.

Steps that say "navigate" mean the ordinary way for that screen reader (virtual cursor or browse mode for NVDA, VO keys for VoiceOver, swipe for TalkBack and iOS).

### 1. Connecting, and a failed connect

1. Navigate to the address field. Expected: "Endpoint URL", edit field. Navigate to the token field: "Bearer token (optional)".
2. Enter an address that works and press Connect. Expected: "Connecting..." then "Connected to" and the host, without moving focus. (Listen for the status being read a second time: it should not.)
3. Press Stop. Expected: "Disconnected".
4. Enter an address that answers HTTP 403 and press Connect. Expected: the error read at once, for example "HTTP 403 Forbidden", as an alert.
5. Enter an address that answers HTTP 502 and press Connect. Expected: "Connection lost ... Retrying (attempt 1)", then again for each next attempt, **not** every second.
6. Check the connect button is announced as "Connect", "Cancel" or "Stop" as the state changes.

### 2. A finding appearing

1. Connect to a stream that goes quiet after some events (the fixture `f04-silent`, or your own). Open the Doctor with its button. Expected: "Doctor", toggle button, pressed.
2. Wait until the finding appears. Expected: the status "Connection open. 0 errors, 1 warning open." is read once. The Doctor button's name is now "Doctor 1 open warning".
3. Navigate to the Findings list. Expected: a list named "Open findings"; each finding is a button that says whether it is expanded, and reads its severity in words (Warning), its title and its summary.
4. Write down whether you would have known the finding appeared if you had not been told to look. This is the question the "not read out by itself" limit hangs on.

### 3. Opening a finding's evidence

1. Open a finding with Enter. Expected: "expanded". Navigate into it. Expected: headings "Observed", "Inferred, not measured", "Limits", in that order, each followed by the statements.
2. Navigate to an evidence chip. Expected: "record #N", a time, and a note, as a button, "collapsed".
3. Press it. Expected: "expanded"; the next stop is a scrollable region named "Raw record N" with the record's text, and a line saying the values are raw, not redacted.
4. Check you can read the record by moving through it and scroll it with the arrow keys.

### 4. The Failure lab

1. With nothing connected, open the Doctor and choose "Try the Failure lab". Expected: the button says it expands, and a list of runs appears with headings by family.
2. Navigate to "Run the Doctor on f04-silent" and press it. Expected: the status "The Doctor ran on f04-silent: it found what this stream was built to show, with 1 finding. The result is below the list." Focus stays on the button.
3. Navigate to the result: a region "The Doctor on f04-silent", a verdict, a list "What was expected" with "Expected stall.silent:bytes: found", then the findings.
4. Choose "Show its healthy twin". Expected: the result changes; a list item reads "No finding at all: none appeared". Check you are told the result changed (you may not be: write it down).

### 5. The export dialog and its warning

1. Open the Doctor with a stream whose data carries something secret-looking (the fixture `f08-echo` does) and press "Export...". Expected: a dialog, "Export from the Doctor", and focus is inside it, on the Close button.
2. Press Tab through the dialog and Shift+Tab back. Expected: focus never leaves it.
3. Move through "What to export". Expected: a group with nine radio buttons; each announces its label, "redacted" or "local only", and its description.
4. Select a shareable kind. Expected: "Redaction replaced N values ..." and, if something may still be secret, an alert "N things may still be secret after redaction. The values are not shown here ..." read at once.
5. Navigate to the preview. Expected: a region "Preview of" and the file name. The Download button is **disabled** until the checkbox "I have looked at the preview ... safe to share" is checked.
6. Select "Full local capture". Expected: a note "This file is not redacted ...".
7. Press Escape. Expected: the dialog closes and focus is back on "Export...".

### 6. The copy confirmation

1. In the events list, navigate to an event's Copy button and press it. Expected: an alert dialog, "Copy a raw value?", with its warning ("as received, not redacted ... may contain secrets") read, and focus on Cancel.
2. Press Cancel. Expected: the dialog closes, focus returns to Copy, nothing is copied.
3. Press Copy again and then "Copy anyway". Expected: "Copied the raw value to the clipboard." read, and the button now says "Copied!".
4. Paste somewhere to check the clipboard holds the value.

### 7. The Multi-Stream lanes

1. Choose Multi-Stream. Expected: the button says it is the current one. Navigate to "Stream name", "Stream URL" and "Bearer token (optional)" fields and the Add button.
2. Add two lanes and press Connect on each. Expected: each Connect is announced as "Connect" with the lane's controls grouped with the lane's name and address; the count "1/2 live" changes (check whether it is read).
3. Add a lane with an address that answers HTTP 403 and connect it. Expected: the error read at once, as an alert.
4. Open the Doctor. Expected: a "Stream Doctor for each lane" region; the fleet strip with figures in a list of terms and values; "Per lane" opens a table with a caption "Each lane's state and counts" and column headers. Navigate the table by cell and check each cell is read with its row and column header.
5. Check each lane's Doctor is a separate section whose heading says which lane ("Doctor: orders").

### After the run

Record the screen reader, its version, the browser, the operating system, and for each step what you heard. Where you heard nothing, or something misleading, say what you expected. Open an issue with the results. Until then, this page stays as it is: **not tested with a screen reader.**
