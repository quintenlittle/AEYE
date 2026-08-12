# AEYE plugins

Wire a local command-line tool into AEYE chat. Start a chat message with a
plugin's **trigger** and the rest of the line is handed to the tool; its
output streams back into the conversation.

## Add a plugin

**Fastest:** in **manage → plugins**, paste a GitHub repo URL and hit **clone**.
AEYE clones it into `plugins/`, scaffolds an `aeye-plugin.json` if the repo
doesn't ship one, and opens it in the inline editor so you can set the command
and trigger. Then **install deps** and go.

Or do it by hand:

1. Put the tool in its own folder here, e.g. `plugins/mytool/`
   (`git clone <repo> plugins/mytool`).
2. Add an `aeye-plugin.json` manifest in that folder (see below), or use the
   **edit** button on the plugin's row to write one in-app.
3. Open **manage → plugins → rescan**. Your trigger is now live in chat.
4. If the tool has a `requirements.txt`, click **install deps** on its row.
   AEYE creates an **isolated `.venv` inside the plugin folder** and
   `pip install`s into it — the tool's packages never collide with AEYE's own
   environment or another plugin's. The runner then uses that venv
   automatically (any `python`/`python3` command runs under it). Re-run the
   button anytime to reinstall/update. You can still install by hand instead;
   the button is just the convenient path.

## Manifest (`aeye-plugin.json`)

```json
{
  "name": "My tool",
  "trigger": "search username",
  "description": "What this does (shown in the plugins tab).",
  "command": ["python", "tool.py", "-u", "{query}"],
  "cwd": ".",
  "timeout": 120
}
```

- **trigger** — start a chat message with this phrase to run the tool. Everything
  after it (an optional leading `:` is stripped) becomes `{query}`.
  `search username: alice` → `{query}` = `alice`.
- **command** — the argv list to execute. Every occurrence of `{query}` is
  replaced with the user's text **as a single argument** — there is no shell, so
  the query can never split into extra arguments or a second command.
- **cwd** — working directory, relative to the plugin folder (default `.`).
- **timeout** — seconds before the run is killed (default 120, max 1800).
- **requirements** *(optional)* — the requirements filename to install
  (default `requirements.txt`). Drives the **install deps** button.
- **mode** *(optional)* — how the tool runs (default `stream`):
  - `stream` — run to completion; stdout/stderr stream into a chat bubble.
    Best for tools that take everything as arguments and print a result.
  - `interactive` — a live prompt/answer **session inside the chat**: the
    tool stays running, its output streams into a bubble, and each chat
    message you send goes to its stdin. Type `/exit` to end it. Works for
    readline-style tools (`input()` prompts); a full-screen TUI does not
    render here — use `terminal` for those. Python tools run unbuffered so
    prompts appear immediately.
  - `terminal` — launch the tool in its **own real console window** with full
    native interactivity (menus, TUIs, colors, keypresses). AEYE is just the
    launcher; output stays in that window, not chat. Windows only. If you want
    the window to persist after the tool exits, make the command
    `["cmd", "/k", "yourtool", ...]` yourself.

## How it runs (and the safety model)

- A plugin runs **only when you type its trigger in the composer**. Model
  replies, memory briefings and document context are never scanned for
  triggers, so a model can't emit a phrase that runs a command on your machine.
- The exact command is shown in the plugins tab before you run it.
- Output (stdout + stderr) streams into a chat bubble; it is **not** added to the
  model's conversation or saved to memory.
- This still runs real local code that you chose to install — treat plugin repos
  with the same trust you'd give any tool you run on your machine. (Clicking
  **install deps** likewise runs the packages' own build hooks via pip.)

The bundled `echo/` folder is a minimal working example — try `echo: hello world`.
