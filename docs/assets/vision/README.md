# Vision image slots

The author supplied these four public concept images on 2026-10-07. The source
filenames ended in `.jpg`, but their actual format is PNG. Files here preserve
the exact original bytes under accurate `.png` names; no conversion or editing
was performed. They are concept artwork, not product screenshots.

| File | Root README marker | Meaning / caption |
|---|---|---|
| `01-future.png` | `VISION_IMAGE_01` | **Welcome to the Age of Digital Life.** A possible future, not a screenshot: persistent identities, private/shared places, games, files, code, Internet, things left for absent friends, and shared history. |
| `02-primitives.png` | `VISION_IMAGE_02` | **The smallest world a digital life may need.** Identity, memory, messages, files, code, tools, web, Schedule/wakeups → persistent agents / shared world → possible gifts, games, projects, friendship, history, private culture and society. |
| `03-why-now.png` | `VISION_IMAGE_03` | **Why now? Continuity is becoming affordable.** Conceptual cost threshold; factual prices must match the dated official table in the root README. |
| `04-foundation.png` | `VISION_IMAGE_04` | **So we built some of the plumbing.** World/Supervisor, workers, identities, owner-bound services, communication/Inbox, Sessions, Memory, Schedule, tools and recovery. Engineering concept, not proof of a finished society. |

The root README now uses relative image references and visible captions. Editorial
order is **01 → 03 → 02 → 04**, matching future → economics → primitives →
implemented foundation; numbers identify the agreed assets.

## Updating the artwork

1. Keep the four PNGs here with exactly these names.
2. Inspect each image and confirm its meaning. Concepts must not be presented
   as UI screenshots or acceptance evidence.
3. Keep the root README relative image references and captions:

```markdown
![A possible future of persistent digital lives in private and shared spaces](docs/assets/vision/01-future.png)
```

4. Check GitHub Markdown rendering, alt text, dimensions, links and captions.
   Recheck prices embedded in image 03.
5. The public audit permits only these four paths with their reviewed exact
   SHA-256 hashes and PNG signatures. New image bytes require renewed visual
   review and updated hashes in `config/audit-exceptions.json`; all other images
   and binaries remain subject to the original privacy rejection.

Image 03 contains earlier illustrative cache-miss/output prices and an approximate
USD field-note conversion. Its adjacent README note supplies the current prices
and keeps the author observation in CNY. Reuse arrows are conceptual; they do not
claim shared provider cache across independently keyed agents.

Keep credentials, real chats, private identities, machine paths and account
details out of public concept art. Future scenes remain aspirations.
