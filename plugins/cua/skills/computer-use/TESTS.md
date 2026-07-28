# Manual Checks

Use these checks after enabling the CUA plugin:

- `check_permissions` reports platform permission state or an explicit unavailable status.
- `list_apps` returns installed desktop apps.
- `launch_app` starts a target app and returns a `pid` when the platform can provide one.
- `list_windows` returns windows for that `pid`.
- `get_window_state` returns a screenshot or accessibility tree for a selected `window_id`.
- `get_desktop_state` returns a full-display snapshot where desktop-scope capture is supported.
- `start_session` keeps `capture_scope: auto` window-only until an explicit `escalate_session`.
- `click` or `set_value` works after a same-window snapshot.
- `get_browser_state` either creates an exact browser/window binding or returns a structured
  refusal; typed browser mutation never proceeds from a heuristic binding.
- `start_recording`, `stop_recording`, and `get_recording_state` are permission-gated.
- `end_session` clears the run's cursor and session state.
- Plugin disable removes the `cua-driver` tools after the tool surface refreshes.
