# @pushary/openclaw

Phone approvals for [OpenClaw](https://openclaw.ai). Before your OpenClaw agent runs a gated tool call, Pushary asks you on your phone. The call runs only after you tap Approve. Anything else blocks it.

It is built for an OpenClaw that runs for you alone, often always on, on a small VPS. It works on the Agent and Agent Pro plans, with push approvals on your phone. Phone calls are not available for OpenClaw yet.

## Install

### With the Pushary CLI (recommended)

Run the Pushary CLI on the machine that runs OpenClaw, as the user the gateway runs as:

```bash
npx pushary@latest setup --agents openclaw
```

Setup signs you in, saves your key in `~/.pushary/config.json`, writes this plugin to `~/.pushary/openclaw-plugin`, and runs:

```bash
openclaw plugins install ~/.pushary/openclaw-plugin --force --accept-capabilities
openclaw plugins enable pushary --accept-capabilities
```

The CLI carries the plugin itself, so `npx pushary@latest upgrade`, or running setup again, installs the newer copy. A running gateway picks up the plugin when the install finishes; a stopped one loads it at its next start. Check it with:

```bash
openclaw plugins inspect pushary --runtime --json
```

`typedHooks` should list `before_tool_call`. Requires OpenClaw 2026.11.3 or later and Node 24.16 or later.

If the gateway runs as another user, or as a service without that home folder, put the key in that user's `~/.openclaw/.env` and restart the gateway:

```bash
PUSHARY_API_KEY=pk_your_key
```

### From ClawHub or npm

```bash
openclaw plugins install @pushary/openclaw        # ClawHub
openclaw plugins install npm:@pushary/openclaw    # npm
```

Then give it a key. Create one at [pushary.com/dashboard/agent/settings](https://pushary.com/dashboard/agent/settings), add `PUSHARY_API_KEY=pk_your_key` to `~/.openclaw/.env`, connect your phone on the same page, and restart the gateway. Until it has a key, every gated call is blocked and the reason says how to add one. `openclaw plugins update pushary` follows newer releases.

Running `pushary setup` later installs the CLI's own copy over a ClawHub or npm install. Both use the plugin id `pushary`, so only one is ever loaded.

## What it gates

- Every `exec` call.
- The `process` actions that send input to a running session: `write`, `send-keys`, `submit` and `paste`. `process send-keys` can type a command into a session that `exec` started in the background, so it asks like `exec` does. `list`, `poll`, `log`, `kill`, `clear` and `remove` do not ask.
- The actions that could switch the gate off or change OpenClaw itself: `plugins` `install`, `enable`, `disable`, `uninstall`, `reload` and `reloadAndResume`; `gateway` `update.run`; and every `openclaw` action that changes config, plugins, agents, channels or the gateway. Their read actions (`plugins` `list`, `inspect` and `search`; `gateway` `config.get` and `config.schema.lookup`; `openclaw` `status`, `config_get`, `plugin_list` and the other reads) do not ask. An action the plugin does not know asks.

- Every `automations` (also called `cron`) action except `status`, `list`, `get`, `runs` and `next_check`. A scheduled job can run a command outside `before_tool_call`, so adding, changing, running or waking one asks.
- Every `terminal` action except `read` and `list`. `terminal input` types into a shared operator terminal.
- Every `nodes` action except the reads: `status`, `describe`, `pending`, `notify`, `camera_list`, `notifications_list` and the `device_*` reads. `nodes run` runs a command on a paired machine, `approve` pairs a new one, and the camera, screen and location actions take data from it.
- Every `sessions_spawn` with `runtime: "acp"`. An ACP session runs Codex, Claude Code or another harness, whose own tool calls never reach this plugin, so starting one asks.
- A `sessions_spawn` with a `cwd` outside the agent's workspace or in its `hooks` or `.openclaw` folder, or with a `projectId`, `projectGitUrl` or `worktree`. The question names the folder.
- Every `write`, `edit` or `apply_patch` into OpenClaw's own files: anything inside an OpenClaw state directory, `~/.config/openclaw` (where Linux keeps `gateway.env`), `~/.pushary`, the `.env` in the gateway's working folder, the config file set by `OPENCLAW_CONFIG_PATH`, and the launchd and systemd files OpenClaw installs for its gateway. The one exception is the agent's own workspace when it lives inside the state directory, which is OpenClaw's default (`~/.openclaw/workspace`). The workspace `hooks` and `.openclaw` folders always ask, wherever the workspace is, because OpenClaw loads code from them: hooks from `hooks`, and plugins from `.openclaw/extensions`, which it finds before the installed ones. The plugin resolves `~`, `@` references, `file://` paths, relative paths against the agent's workspace, and symlinks before it decides, and a path it cannot resolve asks. Writes anywhere else run without asking.

To gate more tools, list their OpenClaw tool ids. The list adds to the defaults above; it never replaces them:

```json5
{
  plugins: {
    entries: {
      pushary: {
        enabled: true,
        config: { gatedTools: ["message", "browser"] },
      },
    },
  },
}
```

Ids are read the way OpenClaw names its tools: `bash` means `exec`, `cron` means `automations` and `tool_call` means `dispatch_action`. An entry that is not a tool id gates nothing, and the plugin logs it as an error when it starts. OpenClaw does not mark a tool call as a message send, a payment or a public post, so gate those by naming the tool that does it, such as `message`.

## What happens to a gated call

| Pushary says | The call |
| --- | --- |
| You answer yes | Runs |
| You answer anything else | Blocked, and the agent is told not to retry |
| No answer before the wait ends | Blocked, and the question is withdrawn |
| OpenClaw cancels the run | Blocked, and the question is withdrawn |
| The agent was stopped from Pushary | Blocked |
| No phone, browser or Slack is connected | Blocked, with a link to connect one |
| Pushary cannot be reached, rejects the key or sends a reply the plugin cannot read | Blocked |
| The call is longer than 4,000 characters once secrets are redacted | Blocked without asking, because Pushary could not show all of it |
| Your delivery mode keeps approvals off the phone, or a When away push window passes with no answer | Withdrawn in Pushary and handed to OpenClaw's own approval prompt, which blocks the call when nobody can answer there. On an OpenClaw older than 2026.11.3 the call is blocked instead |

A missing answer never becomes an approval. A plugin error or timeout blocks the call: OpenClaw fails closed when a `before_tool_call` hook throws or runs out of time, and the plugin turns its own errors into a block rather than relying on that.

## What is sent to Pushary

For each gated call, the plugin sends one `ask_user` request to `https://pushary.com/api/mcp/mcp`, with your key in the `Authorization` header. It holds:

- **The question.** For a command, its first 160 characters, with a note when the command is longer. For a file change, the path. This is what the notification shows; open the request to read the whole call before you answer.
- **The full call.** For `exec`, the whole command, and before it the environment it sets and every other parameter, such as `host`, `node`, `security` and `ask`. The question names the environment variables. For `write`, `edit` and `apply_patch`, the path, the number of lines or changes, and the lines removed and added. For every other tool, its parameters as JSON.
- **Where it comes from.** The agent name (`OpenClaw`, or `OpenClaw - <agent id>`), the tool name, the working directory and whether it asked for elevated mode, the OpenClaw session id or key (hashed when it is longer than 128 characters), a machine id (the one `pushary setup` saved in `~/.pushary/machine-id`, or else a hash of the host name), a random request id, and when the plugin stops waiting.

Before anything is sent, the plugin removes what it can recognise as a secret:

- Key and token formats it knows: Pushary keys, `sk-` keys (OpenAI, Anthropic), Stripe, GitHub, GitLab, Slack, Google, AWS access key ids, npm, xAI and JWTs, plus private key blocks and long base64-like strings of 40 or more characters.
- Passwords in URLs, `Bearer` and `Authorization` values, and the value of anything named like a password, token, secret, API key, access key, client secret or private key. In JSON this holds at any depth, whatever the value.
- For a complete write to a `.env` file (`.env`, `.env.*` or a name ending in `.env`, such as `gateway.env`), Pushary receives the variable names when every line is a plain `NAME=value` assignment, a comment or blank. A file with any other line, such as a value spread over several lines, sends neither names nor values. For an edit or patch, Pushary receives the paths and omits the dotenv change contents because a fragment can start inside a value.

Redaction works from these patterns. A secret in a command that matches none of them, such as a password with spaces passed to a flag of its own, is sent as written. The plugin leaves the rest of a command as it is so you can see what will run.

Characters you could not see, such as zero-width spaces, text direction overrides and terminal escape codes, are sent as visible codes like `\u{202E}`.

While it waits, the plugin sends only the question id, to check for your answer or to withdraw the question. It sends no analytics and talks to no other host.

## How long it waits

The plugin asks OpenClaw for a five minute `before_tool_call` budget and stops waiting ten seconds before it, so it has time to withdraw the question. If you set `plugins.entries.pushary.hooks.timeouts.before_tool_call` or `hooks.timeoutMs`, the plugin reads that value and ends its wait before it instead.

## Where the key comes from

1. `PUSHARY_API_KEY` in the gateway's environment, which OpenClaw also loads from `~/.openclaw/.env`.
2. `apiKey` in `~/.pushary/config.json`, or the file named by `PUSHARY_CONFIG_FILE`.

With no key, every gated call is blocked and the reason says how to fix it.

## Removing it

```bash
npx pushary@latest clean
```

Clean uninstalls the plugin and puts back the `plugins.entries.pushary` settings you had before setup. Without the plugin, OpenClaw's own exec approvals still apply, and nothing reaches your phone.

## Limits

- The gate covers the tools listed above and any you add. It does not see other tools: for example the file-transfer plugin's `file_write` is not gated unless you add it to `gatedTools`.
- ACP sessions set to approve everything, and CLI backends, run tools inside the external harness. Those tool calls never reach `before_tool_call`, so the plugin cannot gate them.
- A command that runs a script file shows the command, not what the script contains. A call longer than 4,000 characters is blocked, so an agent may split it this way: read the script before you approve it.
- This is an approval layer, not a sandbox. Pair it with OpenClaw's own sandboxing and `tools.fs.workspaceOnly`.
- The plugin talks only to `https://pushary.com` and `https://www.pushary.com`, the hosts the CLI uses. Any other `PUSHARY_BASE_URL` blocks every gated call, so a changed setting cannot point it at a server that always says yes.
- The plugin is not told which folder a tool runs in. It resolves a relative path against the agent's workspace, any folder inside it, and the gateway's working folder, and a spawned session in any other folder asks first. A run started some other way in a folder inside OpenClaw's state is not covered.
- Config `$include` files outside the state directory, including roots named by `OPENCLAW_INCLUDE_ROOTS`, are not protected.
- Windows has not been tested.
- Pushary's tool rules from the dashboard are not evaluated on the machine. Every gated call asks.
- Another plugin that rewrites tool parameters can change what runs, including a plugin that runs before this one: OpenClaw gives each plugin its own copy of the call and keeps the earlier plugin's rewrite. Pushary shows and approves the parameters it was given.
- The wait is held inside one gateway process. If the gateway restarts during a wait, OpenClaw drops the call and the question stays in Pushary until it expires.

## License

MIT
