<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Agent input (InputRelay.Apply) accepts only a closed set of kinds, clamps every number and caps text at 256 chars; never add free-form command/script execution — why: datachannel/queue messages are treated as hostile.
- Platform-specific agent behavior uses the shared `src/shared/platform.ts` rules and the persisted `devices.platform` enum only; keep database, API, and UI allow-lists in sync so Windows and Android commands and releases cannot cross — why: OS/version text is free-form and cannot safely discriminate agent capabilities.
