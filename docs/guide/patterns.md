# Pattern Detection

Pattern detection is designed to monitor continuous event throughput for specific anomalous structural heuristics. Rather than actively filtering logs like the Query Engine, the Pattern Engine constantly iterates over the `Ring Buffer` via a Sliding Window Array. 

## Defining Rules

In the `Patterns` panel, you can instruct the engine to track and flag specific criteria. 

### Burst Rules (Frequency Spikes)

A Burst Alert is tripped when a particular event type occurs **more than N times** inside of **T milliseconds**. 

Example: Detect if your Payment Service goes down.
- **Trigger Condition:** `Event Type == "error"`
- **Threshold Limit:** `> 5 Events`
- **Time Window:** `10000ms` (10 seconds)

If the observatory receives 6 error events within any rolling 10-second slice, the UI instantly throws a catastrophic visual `ALARM` block at the top of the interface. 

### Sequence Rules (Workflow Tracking)

A Sequence Rule asserts that certain events must strictly follow one another in exact order across a defined timeframe. 

Example: Assert a Database transaction flow.
- **Workflow:** `req_start` → `db_write` → `req_end`

If `req_start` is seen, the engine expects the subsequent trace IDs. If `db_write` never triggers, but the stream receives a `req_end`, the Sequence Rule trips out of bounds.

## Limitations

Sequence tracking is computationally expensive. Running more than **5 concurrent sequence rules** over a stream pushing `10,000 EPS` will cause the generic UI thread to drop frames heavily. Stick to Burst Rules for high-frequency telemetry.
