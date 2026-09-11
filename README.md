# Obsi Sync

Obsi Sync is a private, sideloaded Obsidian desktop plugin for Git-backed vaults. It keeps the upstream Git workflow—commit, pull, push, history, diffs, line attribution, and source control—while adding optional automatic conflict resolution through a local Codex CLI or OpenCode CLI.

This fork is for personal use. It is not published to the Obsidian Community Plugins catalogue.

## Install from the private Git repository

### Requirements

- Obsidian desktop (AI conflict resolution is intentionally desktop-only)
- Git available on your `PATH`
- Node.js 24 or newer
- pnpm 11 or newer
- An authenticated GitHub SSH key with access to `git@github.com:quaninte/obsi-sync.git`

### Build

```sh
git clone git@github.com:quaninte/obsi-sync.git ~/code/labs/obsi-sync
cd ~/code/labs/obsi-sync
pnpm install
pnpm run build
```

The production build writes `main.js` in the repository root.

### Sideload into Obsidian

1. In Obsidian, open the vault where you want to use Obsi Sync.
2. Create the directory `<vault>/.obsidian/plugins/obsi-sync/`.
3. Copy `main.js`, `manifest.json`, and `styles.css` from the repository into that directory.
4. Restart Obsidian, open **Settings → Community plugins**, and enable **Obsi Sync**.

After source changes, run `pnpm run build` again and replace those three files in the vault. The plugin ID is `obsi-sync`, so it can coexist with the upstream Git plugin, but do not enable two plugins that mutate the same repository at the same time.

For development, use `pnpm run dev` while Obsidian is closed or while you manually reload the plugin after each rebuild.

## First-time setup

1. Open **Settings → Community plugins → Obsi Sync**.
2. Set **Git path** only if Git is not discoverable automatically.
3. Open **Source Control** from the ribbon or command palette.
4. Use **Initialize a new repo** for a new vault, or **Clone an existing remote repo** for an existing remote.
5. Configure your Git author name and email under the plugin settings.
6. Use **Edit remotes** to confirm the remote URL and branch.
7. Make a small change, run **Commit-and-sync**, and confirm the commit appears in the remote repository.

Authentication uses your normal Git setup on desktop: SSH keys, credential helpers, or HTTPS credentials. Obsi Sync does not store provider API keys for Codex or OpenCode; those CLIs use their own local authentication.

## Everyday Git workflow

### Source Control view

The Source Control view shows changed, staged, pulled, conflicted, and untracked files. From the view you can:

- Stage or unstage individual files and folders.
- Open a file diff.
- Discard a file or all local changes.
- Enter a commit message and commit staged files.
- Commit all changes without manually staging each file.
- Open a file or history entry on GitHub when the remote supports it.

### Commands

The command palette includes these groups of commands:

- **Changes:** list changed files, open a diff, stage/unstage the current file, discard all changes.
- **Commit:** commit staged changes, commit with a specific message, commit all changes, or commit all changes with a specific message.
- **Commit-and-sync:** commit-and-sync, commit-and-sync with a specific message, and commit-and-sync then close Obsidian.
- **Remote:** fetch, pull, push, edit/remove remotes, clone, open the current file on GitHub, and open its GitHub history.
- **Branches:** create, switch, delete, and inspect branches.
- **Repository:** initialize a repository, edit `.gitignore`, add the current file to `.gitignore`, and delete the repository.
- **Views:** open Source Control, History, and Diff views.

The normal **Commit-and-sync** sequence is:

1. Stage changes according to the current settings.
2. Create a commit.
3. Pull before pushing when enabled.
4. Resolve conflicts automatically when enabled and a desktop pull conflicts.
5. Push only after the repository is clean and the pull has completed.

Automatic routines can commit-and-sync, commit only, push, pull on a timer, and pull when Obsidian starts. All Git mutations are serialized through the plugin queue.

## Automatic AI conflict resolution

This is an opt-in desktop feature. When enabled and a native Git merge or rebase conflicts, or a safe working-tree/staged integrity check blocks a commit, Obsi Sync runs the selected local CLI in the repository, asks it to edit only the affected files, checks the result, and resumes the original operation if it succeeds.

### Configure it

Under **Settings → Obsi Sync → Automatic conflict resolution**:

- **Enable automatic conflict resolution:** turns conflict resolution and safe integrity repair on. It is off by default.
- **Conflict resolver CLI:** choose `Codex CLI` or `OpenCode`.
- **Conflict resolver model:** enter a Codex model name, or an OpenCode model in `provider/model` form.
- **Conflict resolver timeout:** maximum time for one CLI invocation, from 30 to 1800 seconds.

Examples:

- Codex model: `gpt-5.3-codex`
- OpenCode model: `openai/gpt-5`

The exact model name must be available to the CLI on the machine running Obsidian. Test the CLI in a terminal first:

```sh
codex --version
opencode --version
```

The plugin invokes Codex non-interactively with approval prompts bypassed so the workflow can finish unattended, and invokes OpenCode with its non-interactive `run --auto` mode. The configured model therefore has command execution in the repository; enable this only for a trusted vault and trusted model/provider. The model may read the repository and edit the listed affected files. It is instructed not to reset, clean, stash, checkout, abort, commit, push, or edit `.git`.

### Privacy and safety

Enabling this feature allows the selected model/provider to process conflicted vault content. This may incur provider charges and may send private notes outside the machine. Keep it disabled for vaults whose content must not leave the machine.

The plugin still verifies the repository after the CLI exits. If the CLI fails, times out, edits unexpected files, leaves conflict markers, or Git cannot continue, Obsi Sync blocks the operation and writes the normal conflict instructions for manual recovery. Outgoing-history integrity failures remain blocked because repairing committed history would require a history rewrite. Automatic attempts are bounded; the plugin does not loop indefinitely or reset user work.

### Recovery after a failed attempt

1. Open the Source Control view and inspect the conflicted files.
2. Resolve or revert the files manually.
3. Stage the resolved files.
4. Run **Commit all changes** or the appropriate Git continuation command in your normal Git workflow.
5. Run **Push** after the repository reports no conflicts.

## Sync and commit settings

- **Sync method:** merge, rebase, or reset. Merge is the safest default for a shared vault.
- **Merge strategy:** Git's default strategy, `ours`, or `theirs` strategy option.
- **Pull before push:** fetch remote changes before a commit-and-sync push.
- **Push on commit-and-sync:** disable when you want local backups without uploading.
- **Split timers:** use separate intervals for commit, push, and pull.
- **Commit messages:** configure templates with `{{date}}`, `{{hostname}}`, `{{numFiles}}`, and `{{files}}`.
- **Commit message script:** on desktop, run a local `sh -c` script to generate commit messages. Treat this as trusted local code.
- **Submodules:** optionally update and push submodules recursively on desktop.

## History, diffs, and editor features

- **History view** lists commits, authors, dates, changed files, and file-specific history.
- **Diff view** supports unified Git diffs and a split editor view.
- **Line authoring** shows the commit, author, and date associated with lines in the editor. Configure date format, timezone, colors, follow movement, and whitespace handling.
- **Hunk signs** show added, modified, and deleted hunks in the editor. Optional hunk commands can stage or reset the hunk under the cursor.
- **Status bars** can show the current branch, operation progress, last update, and changed-file counts.

These editor features are independent of AI conflict resolution and continue to work when the resolver is disabled.

## Mobile behavior

The existing JavaScript Git backend can run on mobile with limitations, but automatic CLI conflict resolution is not available there. Mobile users should leave the AI setting disabled and resolve conflicts manually. SSH, large repositories, submodules, and some merge strategies also have platform-specific limitations.

## Development and verification

```sh
pnpm run tsc
pnpm run svelte
pnpm run format
pnpm run lint
pnpm run test
pnpm run build
```

Or run the combined checks:

```sh
pnpm run all
```

The built files are local artifacts for sideloading. This private fork does not publish releases or submit to the Community Plugins catalogue.

## Attribution and license

Obsi Sync is a private fork of the open-source Obsidian Git plugin. Original authorship, historical changelog entries, and the MIT license remain in this repository. This fork is not endorsed or supported by the upstream maintainers.
