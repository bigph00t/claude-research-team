---
name: research-status
description: Check the status of the research service and recent research history.
---

# Research Status

Check research service status and view recent findings.

## When to Use

- Verify the research service is running
- See recent research activity
- Check queue status
- View past findings

## Usage

### Check Service Status
```bash
curl http://localhost:3200/api/status
```

### View Recent Tasks
```bash
curl http://localhost:3200/api/tasks?limit=10
```

### View Recent Findings
```bash
curl http://localhost:3200/api/findings?limit=10
```

### Check Active Sessions
```bash
curl http://localhost:3200/api/sessions
```

## Dashboard

Full dashboard with real-time updates: http://localhost:3200

Shows:
- Queue status (queued, running, completed, failed)
- Active sessions
- Research findings with sources
- Injection history
- Settings configuration
