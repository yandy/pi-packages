# pi-container-sandbox

pi coding-agent extension that runs every read/write/edit/bash op inside a per-session container (docker)

- Host project cwd is mounted read-write at /workspace
- Agent runs as non-root pi user
- No host $HOME, SSH keys, cloud creds, browser state, or Docker socket
- Resource limits via size tiers
- Optional reusable named containers
- One command namespace: /sandbox ...

## Image

Per-project config lives at `.pi/agent/sandbox.json`

```json
{
  "image": "pi-sandbox",
  "tag": "latest",
  "pinned": false,
  "lastDigest": null,
  "lastCheckedAt": null
}
```

Dockerfile lives in `./docker`
