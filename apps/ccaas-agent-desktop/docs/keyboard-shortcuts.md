# Keyboard shortcuts — CCaaS Agent Desktop

All shortcuts are wired through `src/components/workflow/ShortcutsOverlay.tsx`
and are visible to the user via the `?` overlay.

| Shortcut | Action | Notes |
| --- | --- | --- |
| `?` | Open this shortcuts overlay | Disabled while typing in inputs/textareas |
| `Ctrl + A` | Answer the current ringing call | No-op when no call is ringing |
| `Ctrl + H` | Toggle hold on the active call | Only while phase is `talking` |
| `Ctrl + M` | Toggle mute on the active call | Only while phase is `talking` |
| `Ctrl + E` | End the active call (Hangup) | Works in `talking` and `ringing` |
| `Ctrl + Shift + H` | **Transfer the interaction to the AI Agent** | Opens the **Transfer Directory** (AI agent + human queues). In CUA mode the AI destination is auto-selected and the modal auto-confirms. Required by demo acceptance criterion #6. |
| `Ctrl + 1` | Switch to Calls (workspace) | |
| `Ctrl + 2` | Switch to Interactions | |
| `Ctrl + 3` | Switch to Knowledge Base | |
| `Ctrl + 4` | Switch to Statistics | |
| `Ctrl + 5` | Switch to Settings | |

## Conflicts with browser/OS shortcuts

- `Ctrl + 1..5` is intercepted by the app and not the browser's tab-switch
  shortcut while the workspace has focus. On macOS, the equivalent `Cmd`
  combinations are also wired (we listen for `metaKey || ctrlKey`).
- `Ctrl + Shift + H` does not conflict with any major browser default.

## Implementation notes

- The listener attaches to `window` and exits early when the active
  element is an `<input>`, `<textarea>`, or `contenteditable` element.
- All shortcuts honor `prefers-reduced-motion` for the overlay animation.
- `Ctrl + Shift + H` dispatches a `ccaas:open-handoff` custom event on
  `window`, which `RightRail.tsx` listens for to open the Transfer Directory.
  The call-toolbar **Transfer** button dispatches `ccaas:open-transfer` to the
  same handler. This keeps the keyboard/toolbar layer decoupled from the
  workflow component.
