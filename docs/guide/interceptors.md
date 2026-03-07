# JavaScript Interceptors

The Interceptor Editor allows you to write custom JavaScript to mutate, transform, or filter incoming events immediately after they leave the SharedWorker Transport layer, but **before** they enter the Ring Buffer. 

This enables infinite flexibility when dealing with obfuscated or wrapped payloads in raw production environments.

## The Javascript Sandbox

Inside the UI Interceptor panel, you define a single function named `intercept(event)`. 

### The `event` Object
The parameter passed to your function is the raw parsed event containing three core string fields:

```typescript
interface RawEvent {
  id: string;   // The Server-Sent Event ID
  type: string; // The SSE Event type (defaults to 'message')
  data: string; // The raw JSON payload as a string
}
```

## Common Use Cases

### Unwrapping Deep Structures
Backend loggers often wrap critical data inside opaque `_sys` or `_raw` tags.

```javascript
function intercept(event) {
  if (event.type === 'obfuscated_wrapper') {
    // Parse the data field 
    const parsed = JSON.parse(event.data);
    
    // Elevate the nested hidden_payload to the top level 
    const mapped = parsed.hidden_payload;
    
    // Return a new mutated event object
    return { 
      ...event, 
      data: JSON.stringify(mapped), 
      type: 'clean_payload' 
    };
  }
  
  // Return the event unmodified if it doesn't match
  return event; 
}
```

### Dropping Noise (Filtering)
If a stream outputs 10,000 metrics per second but you only care about `error` rates, you can drop the irrelevant events before they hit the memory store.

```javascript
function intercept(event) {
  // Returning null explicitly drops the event from the pipeline entirely
  if (event.type === 'heartbeat') return null;
  return event;
}
```

## Security & Execution Context
The custom JavaScript is executed within a localized, sandboxed `eval()` scope running exclusively inside a segregated `WebWorker`. It does not have access to the `window`, `document`, or standard browser DOM APIs. 

A rogue script containing an infinite `while(true)` loop will intentionally crash the Worker instance, forcing the UI to sever the `SharedWorker` transport and reboot the sandbox cleanly.
