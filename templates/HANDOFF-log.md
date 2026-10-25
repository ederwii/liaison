# HANDOFF log

Append-only history behind `.liaison/handoff/HANDOFF.md`. Never edit or delete an entry; correct a wrong one
with a new entry that says what was wrong.

Append entries below, newest last, each with a `date -u` stamp (`date -u +%Y-%m-%dT%H:%MZ`). One entry per
milestone, decision or correction: what happened, the evidence (measured / inferred / assumed), and links
(PR numbers, shas, question ids).

Entry shape:

```
## YYYY-MM-DDTHH:MMZ <short title>
- what: ...
- evidence: measured | inferred | assumed: ...
- refs: PR #n, sha, question id
```

---
