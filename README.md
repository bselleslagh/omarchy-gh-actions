# GitHub Actions for Omarchy

An Omarchy bar widget that shows the GitHub Actions runs in the repos you subscribe to, and notifies you when a run you care about fails, finishes or waits for approval.

## What it does

- **Repos tab:** press `/` and type to search your GitHub, or type a full `owner/name`. Each repo has a rule for what notifies you: watched runs (the default), all failures or all runs.
- **Running tab:** every active run across your repos, with one block per job.
- **Watch a run:** click it, or press Enter. You get a notification when a job first fails, when the run ends, and when it waits for approval. Runs you start are watched automatically.
- **Job details:** right-click a run, or press the right arrow.
- **Recent tab:** what finished in the last 24 hours, including anything that finished while your computer was asleep.
- **Mine / All:** narrows the lists and the bar count to runs you started or watch.

The first version only reads from GitHub. It has no Re-run or Cancel.

## Bar icon

| Icon | Meaning |
|---|---|
| Dimmed | Nothing is running |
| Number | Active runs |
| Number and bell | At least one of them is a run you watch |
| Pause icon | A watched run is waiting |
| Red | A watched run failed. Clears when you open the panel |
| Warning icon | GitHub can't be reached or the sign-in lapsed. The last known runs stay visible |

## Requirements

- Omarchy with the Quattro shell (plugin support)
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in. The plugin uses your existing sign-in and stores no tokens. If you're signed out, the panel offers a button that starts the browser sign-in.

## Install

```bash
omarchy plugin add https://github.com/bselleslagh/omarchy-gh-actions --enable
```

Pick where the icon goes in the bar (the right section is preselected). Then click the icon, open the Repos tab, press `/` and type a repo to subscribe to it.

To get a newer version later:

```bash
omarchy plugin update io.github.bselleslagh.gh-actions
```

## Remove

```bash
omarchy plugin remove io.github.bselleslagh.gh-actions
```

This disables the plugin, takes its icon off the bar and deletes its files. Your subscriptions and watched runs stay in `~/.local/state/omarchy/gh-actions/`. Delete that folder to remove them too.

## What it does in the background

While you have repos subscribed, the plugin checks GitHub through `gh`: every 20 seconds while runs are active (you can change this in Setup > Plugins), and every minute otherwise. Checks that find no change don't count against GitHub's rate limit, and it pauses when the limit runs low. With no repos subscribed it makes no calls.

Your subscriptions and watched runs are stored in `~/.local/state/omarchy/gh-actions/state.json`. Data goes only between `gh` and GitHub.

## Settings

Under Setup > Plugins:

- Automatically watch runs you start (on)
- Check interval while runs are active (20 seconds)
- Hide the bar icon when nothing is running (off)

## Themes

All colors come from the active Omarchy theme and change live when you switch themes. Passed and waiting states use the theme's `green` and `yellow`.

## Known limits

- A job marked `continue-on-error` can trigger the "is failing" warning even though the run later passes. The final result then replaces the warning.
- "Waiting" can also mean a wait timer rather than a needed approval, so the notification says the run may need your approval.
- github.com only. GitHub Enterprise isn't supported.

## Development

Tests cover the logic in `Model.js` and run with Node's built-in test runner.

Quickshell keeps its own copy of a plugin's files once loaded, so restart the shell to pick up code changes.

## License

[MIT](LICENSE)
