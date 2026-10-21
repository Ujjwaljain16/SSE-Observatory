---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "SSE Observatory"
  text: "Real-Time Streaming Intelligence"
  tagline: Inspect, Diagnose, Reproduce, and Test Server-Sent Events, in the browser and on the command line.
  image:
    src: /logo.png
    alt: SSE Observatory Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View Architecture
      link: /technical/architecture

features:
  - title: Zero-Latency Filtering (DSL)
    details: Build complex Abstract Syntax Trees (AST) using a custom Query language to filter thousands of incoming JSON payloads instantly.
  - title: Multi-Stream Multiplexing
    details: Connect to multiple endpoints simultaneously. The Observatory assigns dedicated lanes and merges everything into one timestamp-sorted global timeline.
  - title: JS Interceptor Sandbox
    details: Write completely isolated `eval()` JavaScript transformations to strip metadata, unpack wrappers, or mutate event structures instantly over the wire.
  - title: Trace Waterfall
    details: Correlate asynchronous transactions using `traceId` attributes. Instantly generate Gantt-chart style visualizations of inter-service latency.
  - title: VCR Mock Server & Replay
    details: Export production incidents as `.sse-record` files, upload them, and time-travel replay the exact bug with pixel-perfect deterministic timing.
  - title: Stream Doctor
    details: Says why a stream is stuck, late or losing events, with the evidence, and turns a captured failure into a regression test. In the app and on the command line.
  - title: Dynamic Schema Inference
    details: Feed in raw JSON blobs and the engine will detect value frequencies, types, and recursive object mappings to generate a living TypeScript Interface.
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #bd34fe 30%, #41d1ff);
}
</style>
