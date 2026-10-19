# Query DSL

The query bar filters events with a small expression language. It is parsed once into a tree and evaluated per event inside the filter worker (or on the main thread when Workers are unavailable). A syntax error is shown under the bar and the list keeps showing everything until the query is valid.

## Fields

- **Event fields:** `type`, `id`, `timestamp`, `parsedType`, `streamId`, `streamColor`, `arrivalTime`. Note that `id` is the observatory's internal id, not the one in your payload.
- **Payload fields:** any path into the JSON payload, with or without a leading `data.`: `data.amount` and `amount` are the same. Use `data.id` for an `id` inside your payload. Array items are written `items[0].id` or `items.0.id`.

Fields may contain letters, digits and `_ $ . - :`. Anything else must be quoted.

## Operators

| Operator | Example |
|---|---|
| `==`, `=`, `!=` | `type != "heartbeat"` |
| `>`, `>=`, `<`, `<=` | `data.amount >= 500` |
| `contains` | `data.message contains "failure"` |
| `matches` (regex) | `data.ua matches "curl/.*"` |
| `in [ ... ]` | `data.level in ["warn", "error"]` |
| `exists` | `data.user.id exists` |

Values are `"strings"`, `'strings'`, numbers, `true`, `false`, `null`, or a bare word.

## Combining

`NOT`, `AND`, `OR` (case-insensitive, in that order of precedence) and parentheses:

```text
type == "transaction" AND (data.price > 1000 OR NOT data.user.verified == true)
```

Keywords are only recognised as whole words, so a field called `ORDER_ID` or `ANDROID` is just a field.

## Performance

The filter keeps a bounded copy of the buffer and only evaluates new events, so cost is proportional to the events arriving, not to the buffer size. Regex (`matches`) is compiled once per query. Very expensive patterns are still expensive: prefer `==`, `in` and `contains` on hot streams.
