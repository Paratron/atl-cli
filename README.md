# atl-cli

Zero-dependency command line client for **Jira**, **Confluence** and the **Atlassian notification bell** (Atlassian Cloud).

- No `node_modules`: only Node.js ≥ 20 built-ins (`fetch`, `util.parseArgs`), so there is no supply chain to compromise.
- API token is stored in the macOS keychain, not in files.
- Markdown in, Markdown out: descriptions, comments and pages are written as Markdown and converted to Jira wiki markup / Confluence storage format.
- `--json` on every command for scripts and AI agents, `--dry-run` for every write.

## Install

```sh
git clone https://github.com/Paratron/atl-cli.git
cd atl-cli
npm link        # makes `atl` available globally
```

## Login

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>, then:

```sh
atl login --site your-site --email you@example.com   # prompts for the token
atl status
```

Site and email are stored in `~/.config/atl/config.json`, the token in the keychain (service `atl-cli`).
On other systems or in CI, set `ATL_SITE`, `ATL_EMAIL` and `ATL_TOKEN` instead.

## Usage

```sh
atl help                     # all commands
atl <group> help             # commands of one group
```

### Notifications

```sh
atl notifications list --unread            # what the bell shows (● = unread)
atl notifications list --unread --direct   # only things addressed to you
atl notifications read <id|groupId>...     # mark as read (also: --all [--direct|--watching])
atl notifications unread <id|groupId>...
atl notifications count
```

> Notifications use Atlassian's internal GraphQL API (`/gateway/api/graphql`, `X-ExperimentalApi: notifications`).
> It is not officially documented and may change without notice.

### Jira

```sh
atl issue search "assignee = currentUser() AND statusCategory != Done" --limit 20
atl issue get ABC-123 --comments
atl issue create --project ABC --type Bug --summary "Login fails" --description "## Steps\n1. …" --assignee me
atl issue update ABC-123 --add-labels frontend --due 2026-12-01 --assignee "Jane Doe"
atl issue comment ABC-123 --body "Looks good, **merging**."
echo "long markdown" | atl issue comment ABC-123
atl issue transitions ABC-123
atl issue transition ABC-123 "In Review" --comment "Ready"
atl issue assign ABC-123 me
atl issue link ABC-123 blocks ABC-456      # relation = link type name, outward or inward phrase
atl issue links ABC-123 · atl issue unlink <linkId> · atl issue link-types
atl issue watchers|watch|unwatch ABC-123
atl issue worklog ABC-123 · atl issue log-work ABC-123 1h 30m --comment "Review"
atl issue changelog ABC-123 · atl issue dev ABC-123
atl issue attachments|download|attach ABC-123 [files…]
atl issue meta --project ABC [--type Bug]  # issue types / fields for create
atl issue delete ABC-123 --yes

atl project list · atl project versions ABC · atl project components ABC · atl project create-version ABC 1.2.0
atl field search sprint
atl board list --project ABC
atl sprint current --board 42 [--mine] · atl sprint list --board 42
atl sprint add <sprintId> ABC-1 ABC-2 · atl sprint backlog ABC-1 · atl sprint create|update …
atl user me · atl user search "jane"
```

### Confluence

```sh
atl page search "release notes" --space DEV
atl page search 'label = "adr" AND type = page'      # raw CQL
atl page get <id|url>                                # body as Markdown (--raw for storage XHTML)
atl page create --space DEV --title "ADR 12" --file adr-12.md [--parent <id>]
atl page update <id> --file page.md [--title …] [--message "why"]
atl page update <id> --append --body "## Update\n…"
atl page comment <id> --body "Question: …" [--reply-to <commentId>]
atl page comments|children|tree|history <id>
atl page diff <id> [--from 10 --to 12]                # what changed between versions
atl page labels <id> · atl page label <id> adr [--remove]
atl page attachments|download|attach <id> [files…]
atl page move <id> --parent <id> · atl page delete <id> --yes
atl space list
```

Input formats: `--format markdown` (default), `wiki` (Jira wiki / Confluence wiki markup) or `storage` (Confluence XHTML).

## Development

```sh
npm test
ATL_DEBUG=1 atl …   # stack traces on errors
```
