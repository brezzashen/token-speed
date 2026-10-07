# Agent setup prompt

Copy the block below into your coding agent (Claude Code, Codex or similar).
The agent installs Token Speed on your machine and checks that it works.

```text
Install and configure Token Speed from https://github.com/brezzashen/token-speed on this machine.
It is a local dashboard. It reads the conversation records that Claude Code and Codex already write,
and shows output speed (token/s). It never calls a model provider. Follow these steps in order.
Report the result of each step. Stop and ask me if a step fails or a choice is unclear.

1. Check the prerequisites.
   - Run `node -v`. Node must be 22.18 or newer. If it is older, stop and tell me.
   - Run `bun -v`. Bun is needed only for the browser build. If it is missing, use `npx -y bun` in step 3.
   - Run `git --version`.

2. Clone the repository and install dependencies.
   - Clone it into a directory I approve (default: ~/token-speed).
   - In that directory, run `npm install`.

3. Build and test.
   - Run `npm run build`. It must create `web/dist/app.js`.
   - Run `npm test`. All tests must pass. If a test fails, stop and show me the output.

4. Find the agent profiles on this machine. Do not read conversation contents; check only that the paths exist.
   - Claude Code home: `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. It counts only if it has a `projects/` directory.
   - Codex home: `$CODEX_HOME` if set, else `~/.codex`. It counts only if it has a `state_<number>.sqlite` file.
   - Look for extra homes too, for example `~/.claude-*` or `~/.codex-*` used for other accounts.
   - Show me the list and ask which profiles to watch and what short name each one gets.

5. Build the profile setting.
   - The format is `name:agent:home`, comma separated. `agent` is `claude` or `codex`.
   - A name uses letters, digits, `.`, `_` or `-`, at most 32 characters.
   - Example: `TOKEN_SPEED_PROFILES=work:claude:~/.claude,personal:codex:~/.codex`
   - If I only use the default homes, leave `TOKEN_SPEED_PROFILES` unset.

6. Start the server and verify it.
   - Run `TOKEN_SPEED_PROFILES=... npm start` in the background.
     Optional: `TOKEN_PORT` (default 8047) and `TOKEN_HOST` (default 127.0.0.1).
   - Wait 5 seconds. Run `curl -s http://127.0.0.1:8047/health`. `observedAt` must not be null.
   - Run `curl -s http://127.0.0.1:8047/api/speed`. `accounts` must list my profiles.
     `samples` can be empty if I have no conversation in the last hour; that is not an error.
   - Check that the response has no file paths and no conversation text.
   - Give me the URL http://127.0.0.1:8047/ to open.

7. Ask me before you do either of these:
   - Keep it running after reboot (launchd on macOS, systemd user service on Linux, or pm2).
     Use the absolute path of `node` and the repository directory, and set the same environment variables.
   - Expose it beyond this machine. Keep `TOKEN_HOST=127.0.0.1` and put it behind a reverse proxy
     with HTTPS and access control. The page has no login of its own.

Rules:
- Do not change files in the Claude Code or Codex homes. Token Speed only reads them.
- Do not print, copy or upload conversation records, auth.json contents or tokens.
- Do not commit anything to the repository unless I ask.
```

## Notes for the person running the agent

- A Claude card shows one whole-response rate. Claude Code records do not time thinking and text apart.
- A Codex card shows thinking and output rates separately.
- Speed appears only after a conversation finishes a timed generation segment.
- If a Codex home has `auth.json` with an account ID, only that account's sessions count.
