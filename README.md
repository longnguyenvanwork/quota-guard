# quota-guard

A Claude Code mod for people who use several Claude accounts through
[cswap (claude-swap)](https://github.com/realiti4/claude-swap).

- **Status line**: the active account, the 5-hour and weekly usage, and when
  each resets. The same line is shown under every answer, for surfaces that
  draw no status line.
- **One account near its limit** (95%): switches to another account with
  `cswap switch`, in the running session, without a restart.
- **Every account near its limit**: denies tools from the next call on, so the
  rest of the quota is not spent, and resumes the same session by itself when
  the earliest account resets (plus two minutes).
- **`/quota`**: usage of every cswap account. **`/quota resume`** ends a pause now.

## Needs

- `cswap` on the PATH or in `~/.local/bin` (`uv tool install claude-swap`),
  with each account added (`/login`, then `cswap add`).
- Optional: `cswap auto` running in the background, which switches even when no
  session is calling tools.

## Install

At the prompt of a terminal session:

```
/plugin install quota-guard --marketplace longnguyenvanwork/quota-guard
```

From a shell:

```
claude plugin install quota-guard --marketplace longnguyenvanwork/quota-guard
```

The repository is private: the machine must already hold a git credential for
github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).
