# Pattern Detection

Pattern rules watch the live stream and raise an alert when something notable happens. Each event is examined once per rule as it arrives, so the cost does not grow with the buffer size.

A rule's event type matches either the SSE event name or the `type` field of a JSON payload. `*` matches anything and `prefix*` matches a prefix (`payment_*`).

## Burst rules

A burst alert fires when **at least N** matching events arrive within a window of **T milliseconds**.

Built-in rules: *Error burst* (5 `error` in 10 s), *Retry storm* (3 `retry` in 5 s), *Alert burst* (10 `alert` in 2 s).

A burst raises **one** alert per episode. The rule re-arms only after the rate drops below the threshold again, so a sustained storm does not flood you with alerts.

## Sequence rules

A sequence rule lists event types that must arrive **consecutively**, for example `payment_failed → retry_payment → retry_payment`. When the last type arrives and the previous events match the list in order, an alert is raised. Matches do not overlap: the events of one alert are not reused for the next.

## Good to know

- Editing, enabling or re-adding a rule re-evaluates it against what is currently in the buffer; other rules keep their state.
- Detection state resets when the buffer is replaced (a new connection, or loading history).
- Alerts keep the newest 50 matching events and the true count; the alert list keeps the latest 200.
