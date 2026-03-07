# Mock Server & Time-Travel Replay

Because SSE Observatory uses an internal `Ring Buffer` decoupled from network ingestion, any session you run can be saved, exported, and perfectly replayed identically later.

This allows developers to **time-travel debug production incidents** locally, without needing to maintain live access to the production endpoint or repeatedly crash the backend simulating errors.

## Exporting a Session
1. When connected to a live stream, navigate to the **Data Storage** panel.
2. Click **Export Current Buffer**.
3. Select the `.sse-record` format. 

This downloads a specialized JSON file locally. The `.sse-record` format stores exact Byteframes from the network layer alongside a highly accurate relative `deltaMs` property mapping precisely when the event arrived compared to the previous payload.

## Replaying a Session
To perform time-travel debugging:

1. Click on the **Mock Server** tab.
2. Select **Upload .sse-record**.
3. Point it to the file you exported previously.

Once loaded, the Mock Server intercepts the primary transport layer. When you click "Play", the UI begins iterating through the file and artificially dispatching pseudo-events back into the Ring Buffer with perfectly matched chronological spacing.

### Adjusting Playback

You have complete control over the time-travel velocity:
- **0.5x:** Slows down high-throughput sessions to observe race conditions visually.
- **1.0x:** Real-time production playback.
- **2.0x:** Accelerated parsing.

### Engine Compatibility
Because the Mock Server simply replaces the primary socket transport, **All other features work natively during replays**. 
While time-traveling, you can apply Query DSL AST filters, alter the JS Interceptor logic, and trigger real-time Pattern Burst alarms against the historical file data.
