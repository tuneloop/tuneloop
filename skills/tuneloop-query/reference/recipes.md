# Recipes

Worked queries for the common analyses. Each respects the grain rules in
[../SKILL.md](../SKILL.md) — cost/tokens at usage grain, no
`usage_facts`×`tool_calls` join.

Sidechain vs main-thread spend:
```sql
SELECT CASE WHEN is_sidechain = 1 THEN 'sidechain' ELSE 'main' END AS thread,
       ROUND(SUM(cost_usd), 2) AS cost
FROM usage_facts GROUP BY is_sidechain;
```

Cost per model (at usage grain):
```sql
SELECT model, ROUND(SUM(cost_usd), 2) AS cost,
       SUM(tok_input + tok_output + tok_cache_create_5m + tok_cache_create_1h + tok_cache_read) AS tokens
FROM usage_facts GROUP BY model ORDER BY cost DESC;
```

Cache leverage (cache reads as a share of input):
```sql
SELECT ROUND(SUM(tok_cache_read) * 1.0 / NULLIF(SUM(tok_input + tok_cache_read), 0), 3) AS cache_hit_ratio
FROM usage_facts;
```

Slowest tools by average latency:
```sql
SELECT name, COUNT(*) AS calls, ROUND(AVG(duration_ms)) AS avg_ms, MAX(duration_ms) AS max_ms
FROM tool_calls WHERE duration_ms IS NOT NULL
GROUP BY name ORDER BY avg_ms DESC LIMIT 20;
```

Generic tool `action` breakdown (Bash sub-commands, skill invocations, …):
```sql
SELECT name, action, COUNT(*) AS n FROM tool_calls
WHERE action IS NOT NULL GROUP BY name, action ORDER BY n DESC LIMIT 30;
```

PR cycle time (created → completed):
```sql
SELECT a.ident AS pr, a.repo,
       ROUND((julianday(a.completed_at) - julianday(a.created_at)) * 24, 1) AS hours
FROM artifacts a
WHERE a.kind = 'pr' AND a.completed_at IS NOT NULL
ORDER BY hours DESC;
```

Spend by branch (session facet joined up to usage grain):
```sql
SELECT s.branch, ROUND(SUM(u.cost_usd), 2) AS cost
FROM usage_facts u JOIN sessions s ON s.id = u.session_id
GROUP BY s.branch ORDER BY cost DESC;
```
