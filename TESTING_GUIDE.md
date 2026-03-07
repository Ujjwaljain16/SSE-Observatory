# SSE-Observatory Pro: Manual Testing Guide

This guide provides a structured walkthrough to verify every feature of the platform using the **Chaos Stream** (`http://localhost:4000/chaos-stream`).

## 🚀 Step 1: Initialization
1.  **Launch Servers**: Ensure both `npm run dev` and `npm run chaos` are running.
2.  **Navigate**: Open `http://localhost:3001` in your browser.
3.  **Enter URL**: Paste `http://localhost:4000/chaos-stream` into the **SSE Endpoint URL** field.
4.  **Connect**: Click the **Connect** button.

---

## 🛰️ Step 2: Monitor Mode Features

### 1. Connection Dynamics
-   **Initial Burst**: You should see exactly **50 events** arrive in a split-second "burst" the moment you connect.
-   **Continuous Streaming**: After the burst, the server enters "Live Mode," sending 1 new event every 500ms. This is why your count will keep climbing to 100, 200, and beyond!
-   **Status Bar**: Notice the "Connected" pulse and the live **Connection Time** counter.
-   **Abort Logic**: While connecting, the button turns to **Abort**. This is critical for stopping hung requests.

### 2. Live Events & Details
-   **Event Cards**: Each event arrives as a sleek, color-coded card. 
-   **Auto-Parsing**: The app automatically tries to parse JSON. If successful, you'll see a formatted, syntax-highlighted block immediately.
-   **Compare (Diff)**: Click the **Compare** button on any event to see a visual diff between it and the event right before it. This is amazing for spotting exactly what changed in a state update! 🧬
-   **Copy**: Use the **Copy** button to grab the raw data for your own use.

### 3. Time-Travel Debugging (Playback)
-   **Pause**: Click the **Pause** icon on the playback bar. Everything freezes in place in your viewer.
    -   > [!NOTE]
    -   **Record-while-Paused**: Even while the viewer is paused, the platform continues to record every event in the background. 
    -   **Resume to Live**: When you click **Play/Resume** while you are in the past, the app now automatically jumps you back to the **Live** edge. 🚀
-   **Step**: Use **Step Forward** / **Step Backward** to move through history event-by-event.
    -   **Visual Change**: 
        -   **Step Backward**: The most recent event (the one at the top) will *disappear* from the list. You are effectively "undoing" time to see what the list looked like before that event arrived.
        -   **Step Forward**: The next event in the timeline will *reappear* at the top.
        -   **Timeline Slider**: You will see the slider nub move left or right along with your steps.
-   **Go Live**: Click **Live** to jump back to the "Edge" of the stream.

### 4. Advanced Filtering (DSL & Search)
-   **Search**: Type "burst" in the search bar. The list should only show the initial 50 events.
-   **Query Bar**: Type `data.val > 40`. The UI will instantly narrow down to just those specific high-value events.
-   **Custom Filters**: 
    -   Find the **Custom Filters** panel.
    -   Add a filter for the field `type`. 
    -   Select "burst" or "custom" to toggle visibility.
    -   Toggle **Regex Mode** to search using patterns (e.g., `^b.*t$`).

---

## 🧬 Step 3: Analytical Precision

### 1. Schema Analyzer
-   **Action**: Click the **Inferred Schema** tab or toggle.
-   **Verification**: Because the Chaos Server sends varying JSON, you should see multiple detected fields. It handles "ghost fields" (missing values) gracefully with optionality markers.

### 2. Timeline Visualization
-   **Action**: Look at the **Stream Pulse** chart.
-   **Verification**: Each dot represents an event. Hover over them to see timestamps. This helps identify "Event Clusters" or delivery gaps.

---

## 🌪️ Step 4: Chaos Testing (Resilience)
The **Chaos Server** is designed to break things. Watch how the app recovers:

1.  **Malformed JSON**: The server occasionally sends invalid JSON. 
    -   **Result**: The app marks these as "Malformed" but continues running without crashing.
2.  **Connection Drops**: The server will end the stream randomly.
    -   **Result**: You will see **"Connection lost. Reconnecting... (1/3)"**. The app will automatically try to re-establish the link without clearing your history.
3.  **Stream Completion**: After a specific duration or if the server closes cleanly.
    -   **Result**: You'll see the newly polished **"Stream completed or closed by server"** message.

---

## 💾 Step 5: Persistence & Export
1.  **Profiles**: Enter "Chaos Lab" in the **Profile Name** and click **Save**. Switch to another tab and back—your URL and token are preserved.
2.  **Export**: 
    -   Click **Export JSON** to save the session.
    -   Click **Export for VCR** to save a `.sse-record` file. This file includes the high-precision timing needed for Mock Server Mode.

---

## 🔄 Step 6: Mock Server Mode (The VCR)
1.  **Switch Mode**: Click **Mock Server Mode** in the main header.
2.  **Upload**: Select the `.sse-record` file you just exported (or use the provided `sample.sse-record`).
3.  **Start Server**: Click **Start Mock Server**.
4.  **Verification**: 
    -   The UI will show a **Mock URL** (e.g., `http://localhost:3001/api/mock/stream`).
    -   Switch back to **Monitor Mode**.
    -   Paste that Mock URL and connect.
---

## 💡 Pro Tip: Learn the Flow with "Simple Server"
If the Chaos Server is too fast for learning:
1.  **Launch Simple Server**: Run `npm run simple` in a new terminal.
2.  **Connect**: Use `http://localhost:4001/stream`.
3.  **The Experience**: This server sends exactly **5 events**, spaced **2 seconds apart**. 
    -   This gives you plenty of time to click **Pause** after Event #2.
    -   Click **Step Backward** to see Event #2 disappear.
    -   Click **Step Forward** to see it return.
    -   Explore the **Schema** and **Stats** without the list scrolling away! 🐢🔭
