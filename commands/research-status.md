---
description: "Check the status of the research service and recent research history"
---

# Research Status

Check if the research service is running and view recent research tasks.

## How to Execute

1. Check service health:
```bash
curl -s http://localhost:3200/api/health
```

2. Get queue status:
```bash
curl -s http://localhost:3200/api/queue
```

3. Get recent research history:
```bash
curl -s http://localhost:3200/api/history?limit=10
```

## Present Results

Show the user:
- Service status (running/stopped)
- Queue length and active tasks
- Recent research queries and their status
- Link to dashboard: http://localhost:3200

## If Service Not Running

Inform the user to start it:
```bash
cd /home/bigphoot/Desktop/Projects/claude-research-team && npm run start
```
