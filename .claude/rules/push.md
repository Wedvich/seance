---
paths:
  - "daemon/src/{push-sender,web-push,*-alerts,archivist-silence}.ts"
  - "scheduler/src/alerts.ts"
  - "daemon/test/{push-endpoint,push-sender,web-push}*.ts"
  - "pwa/public/push-sw.js"
  - "pwa/src/{push,push-browser,deep-link,deep-link-browser,sw}.ts"
---

# Web push

Requirements, not observations: DESIGN.md's Threat model is the record.

- A push send goes only to an endpoint `pushEndpoint` accepts at send time (https, a `PUSH_SERVICE_HOSTS`
  host), redirects refused and timed out, never awaited by the scheduler pass.
- Its payload carries ids and state only (never a tag), and no endpoint, key, JWT or payload is logged.
- The service worker (`pwa/public/push-sw.js`) holds no PSK, so a notification's text is fixed per kind:
  - a spill's window label shown only as one of the known `5h`/`7d`;
  - a blocked PR's one of four texts by its `reason`, an enum;
  - a quota-exhausted's window shown only as `5h`/`7d` and its one of two texts by `reason`, an enum;
  - a pass-refused's text fixed;
  - the archivist's silence one text, nothing of its payload shown;
  - a flag's one of four texts by its `reason`, an enum, and a generic one for any other value, the note
    never shown;
  - a login's one of two texts by its `state`, an enum, and an agent login's (its `exclave` the fixed
    `LOGIN_ALERT_KEYS` key, never shown) its own one text;
  - a failing custodian's one text, opening only `/?screen=machines`;
  - a GitHub budget's one of two texts by its `resource`, an enum, opening only `/?screen=machines`.
- A click opens only a same-origin path it built from an id that passed `isTaskId` (`/?task=<id>`,
  `/?screen=machines`), which the app reads back through the same rule.
