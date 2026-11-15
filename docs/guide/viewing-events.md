# Viewing events

How the event list shows what arrived, and what each view does and does not tell you.

## Payload views

Every event row has a small switch above its payload:

| View | What it shows |
|---|---|
| **JSON** | The payload pretty-printed, with colours for keys, strings, numbers and `true`/`false`/`null`. The text is exactly what **Copy** copies. A payload of more than 8,000 characters is shown without colours: thousands of coloured pieces per row cost more than they are worth. Anything that is not JSON is shown as plain text. |
| **Tree** | Only for a JSON object or array. A collapsible tree: the first two levels are open, deeper ones are a click away, and a list of more than 100 items is shown in pages of 100. |
| **Raw lines** | The event's own lines (`id:`, `event:`, `data:`, ...) as the parser read them, with line endings normalised. **This is not the wire bytes**: it does not show comment lines between events, chunk boundaries or the original line endings. The command line keeps the wire bytes in its captures. |

The choice is per row and lasts until the page is reloaded.

## Collapse repeats

**Collapse repeats** folds consecutive events with the same name and the same data (a heartbeat, a polled value that did not change) into one row marked `×N identical`. Only a run of neighbours is folded: two identical events with something different between them stay two rows, because the difference is part of what happened. Events from different streams are never folded together. The choice is kept in this browser.

The **Compare** button on a row compares it with the next row in the list, which is the previous *different* event while repeats are folded. A finding's **Show this event in the list** finds the event inside a folded row too.

## Event rate

The figure beside **LIVE** is events per second over the last five seconds, measured from the times the page received the events (it updates once a second, so it falls to zero when the stream goes quiet). It is the page's view of the stream. The list keeps the latest 1,000 events, so at a very high rate the figure is calculated from the span those 1,000 cover, not from five seconds.

## Display mapping

A stream in a format of its own (chat chunks, a changelog feed, anything with the interesting part three levels down) can be put into the common view. In the Doctor's **Profile** tab, **How to show the events** takes three JSON paths:

| Path | Shown as |
|---|---|
| **Type** | the type badge (instead of the SSE event name or a `type` field), and what the type chart counts |
| **Summary** | a one-line summary above the payload, for example `$.choices[0].delta.content` |
| **Id** | an id badge |

A path that finds nothing in an event leaves that part as it was, and an event whose data is not JSON is shown as before. A number, `true`/`false` or an object is written as text and long values are cut at 200 characters. The form shows what the newest event would show before you save. The mapping is part of the [profile](/guide/stream-doctor#profile), so it is the same file the command line reads; only the app uses it, and no check depends on it.

## Event types

**Stats** shows the event types as bars, largest first, with the count and share of all events held; the eight most common are listed and the rest are folded into **other**. The count and the percentage are written next to each bar: the bar is only a quick comparison. Events whose JSON payload has a `type` field are counted by that value, as everywhere else in the app.

## Followed fields

In **Stats**, **Followed fields** shows what one field of the payload did across the events. Type a path (the box suggests the fields of the latest events) or pin one in the Doctor's profile tab; the two lists are the same.

- A **number** is drawn as a line (a long series is averaged down to 120 points, keeping its shape), with the first and newest value, the lowest, highest and mean, how many steps went up and down, and whether it counted up by one.
- **Text** and **true/false** are shown as their most common values with counts. More than 5,000 different values are not counted further, and the card says so.
- A field that is in only some events says how many ("In 4 of 6 events"), and a field that holds different kinds of value says it is mixed.

It looks at the events the page holds (the newest 1,000). **Include saved history** reads the browser's saved history as well, up to the newest 20,000 events, and says which it is looking at. Paths are read the same way as the profile's, and only the payload's own properties are followed.

## The Doctor's Request tab

See [Stream Doctor](/guide/stream-doctor#request).
