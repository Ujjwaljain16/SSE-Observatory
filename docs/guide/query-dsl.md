# Query DSL Engine

Deep JSON payloads render standard text search functionally useless. To accommodate Enterprise structures, SSE Observatory leverages an Abstract Syntax Tree (AST) custom parser capable of real-time logic evaluations on a per-event basis.

## Syntax Rules

Expressions consist of operands (paths to data) evaluated against literals using comparison algorithms inside the dedicated `Filter Worker Thread`.

### Supported Operators

| Logic | Symbol | Example |
|---|---|---|
| Equality | `==` | `user.role == "admin"` |
| Inequality | `!=` | `type != "heartbeat"` |
| Greater Than | `>` | `data.amount > 500` |
| Less Than | `<` | `data.duration < 10.5` |
| Regex Matching | `matches` | `headers.userAgent matches "curl/.*"` |
| Contains Substring | `contains` | `data.message contains "failure"` |

### Boolean Aggregations

Queries can be nested infinitely via `AND` or `OR`.

```sql
type == "transaction" AND (data.price > 1000 OR user.is_flagged == true)
```

## Performance Note

String matching (`matches`, `contains`) evaluates slower through AST pipelines than explicit numeric thresholds. For streams exceeding `15,000 EPS`, favor explicit index equality logic over Deep Regex mapping to prevent frame stutter.
