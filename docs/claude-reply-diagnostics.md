# Reproduce a Claude comment reply failure

Copy `scripts/reproduce-claude-reply.mjs` to the affected machine. It is standalone;
it needs Node.js 18 or later, Claude Code, and the existing AI Overview settings.
Run it from a regular terminal, using the affected vault and note:

```sh
node /path/to/reproduce-claude-reply.mjs \
  --vault "/path/to/Obsidian vault" \
  --note "Folder/Affected note.md" \
  --runs 10
```

The default request asks Claude to read and summarize the note, including quoted
text and a fenced example to exercise JSON escaping. It asks for no file edits
or external actions. The CLI retains its configured permissions and integrations,
just as a comment run does. Calls consume normal Claude usage.

The command discovers AI Overview by manifest ID and reads its Claude executable,
model, effort, extra arguments, environment and timeout from `data.json`, even if
another provider is currently selected. It uses the plugin's comment prompt
framing, an empty synthetic thread, and these transport arguments:

```text
--print --output-format stream-json --verbose --permission-prompts none
```

It also supplies `--json-schema` with the shared reply schema. It validates the
final event's `structured_output` and does not fall back to prose from `result`.
See [Claude Code's programmatic output documentation](https://code.claude.com/docs/en/headless#get-structured-output).

For a request closer to the original incident, put the comment text in a UTF-8
file and add `--message-file /path/to/comment.txt`. That executes the supplied
request with the configured CLI permissions; replaying an editing request can
repeat its effects. It does not reconstruct the original thread or quoted excerpt.

The command stops at the first failure and prints the private output directory:

- `summary.json`: CLI version, model, timing and result of each attempted call.
- `prompt.txt`: exact prompt sent to Claude.
- `run-01.stdout.jsonl`: unmodified stdout event stream.
- `run-01.stderr.txt`: unmodified stderr.
- `run-01.reply.txt`: serialized `structured_output` checked by the plugin's parser rules.
- `version.txt`: version lookup output.

`invalid-shape` means structured output fails the reply-only contract.
`missing-structured-output` identifies a successful-looking event without the
required schema result. CLI errors, permissions, timeouts, incomplete event streams
and missing final replies are reported separately. Exit codes are 0 for all attempted
replies passing, 1 for a reply parser failure, and 2 for other errors.

Logs may contain private note content or provider output; inspect them before
sharing. The command does not export configured environment values. A small
sample with no failures does not rule out an intermittent problem or differences
between the terminal's environment and the environment inherited by Obsidian.
If discovery finds multiple installations, use `--plugin-dir` to select the
settings directory used by the running plugin. Custom Obsidian config directories
also need this override.

This is a diagnostic command only. It does not change plugin code, settings, job
history or reply publication behavior.
