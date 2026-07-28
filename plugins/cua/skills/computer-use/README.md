# Computer Use Workflow

This skill uses DeepChat's plugin-provided Computer Use tools.

Core workflow:

1. `start_session`
2. `list_apps`
3. `launch_app`
4. `list_windows`
5. `get_window_state`
6. UI action tool
7. `get_window_state`
8. `end_session`

Use element indices only after a snapshot for the same `pid` and `window_id`. Use pixel coordinates
when the returned screenshot clearly shows a target missing from the accessibility tree.

For Chromium-family page content, bind the exact native window with `get_browser_state` and use the
typed `browser_*` tools. The legacy `page` tool is compatibility-only.

Supported bundled targets:

- `darwin/arm64`
- `darwin/x64`
- `win32/x64`
- `win32/arm64`
- `linux/x64`

Unsupported bundled targets:

- `linux/arm64`

Do not ask the user to install CUA manually for DeepChat's bundled plugin.
