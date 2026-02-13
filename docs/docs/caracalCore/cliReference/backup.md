---
sidebar_position: 9
title: Backup Commands
---

# Backup Commands

The `backup` command group manages backup and restore operations.

```
caracal backup COMMAND [OPTIONS]
```

---

## Commands Overview

| Command | Description |
|---------|-------------|
| [`create`](#create) | Create a backup |
| [`restore`](#restore) | Restore from backup |
| [`list`](#list) | List available backups |

---

## Backup Contents

| Component | Included | Description |
|-----------|:--------:|-------------|
| Principals | Yes | Principal registry |
| Policies | Yes | Authority policies |
| Resource Registry | Yes | Resource registry |
| Ledger | Yes | Authority events |
| Merkle tree | Yes | Integrity proofs |
| Keys | Optional | Signing keys (encrypted) |

---

## create

Create a backup.

```
caracal backup create [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--output` | `-o` | auto | Output file path |
| `--include-keys` | | false | Include encryption keys |
| `--compress` | | true | Compress backup |
| `--format` | `-f` | tar.gz | Format: tar.gz, zip |

### Examples

<details>
<summary>Basic Backup</summary>

```bash
caracal backup create
```

**Output:**
```
Creating backup...

Components:
  [OK] principals (125 records)
  [OK] policies (89 records)
  [OK] resources (45 entries)
  [OK] ledger (1,234,567 events)
  [OK] merkle (committed)

Compressing...
  [OK] Compressed 2.3 GB -> 456 MB

Backup created: ~/.caracal/backups/backup-2024-01-15T103000Z.tar.gz
Size: 456 MB
```

</details>

<details>
<summary>Backup with Keys</summary>

```bash
caracal backup create \
  --output /backup/caracal-full.tar.gz \
  --include-keys
```

**Output:**
```
Creating backup...

[WARNING] Including encryption keys in backup.
          Ensure backup is stored securely.

Components:
  [OK] principals (125 records)
  [OK] policies (89 records)
  [OK] resources (45 entries)
  [OK] ledger (1,234,567 events)
  [OK] merkle (committed)
  [OK] keys (encrypted with master password)

Backup created: /backup/caracal-full.tar.gz
Size: 458 MB
```

</details>

---

## restore

Restore from backup.

```
caracal backup restore [OPTIONS] FILE
```

### Arguments

| Argument | Description |
|----------|-------------|
| FILE | Path to backup file |

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--components` | | all | Components to restore (comma-separated) |
| `--force` | | false | Overwrite existing data |
| `--dry-run` | | false | Preview without restoring |

### Examples

<details>
<summary>Full Restore</summary>

```bash
caracal backup restore backup-2024-01-15T103000Z.tar.gz --force
```

**Output:**
```
Restoring from backup...

[WARNING] This will overwrite existing data.
          Type 'restore' to confirm: restore

Extracting...
  [OK] Extracted 2.3 GB

Restoring components:
  [OK] principals (125 records)
  [OK] policies (89 records)
  [OK] resources (45 entries)
  [OK] ledger (1,234,567 events)
  [OK] merkle (verified)

Restore completed successfully.
```

</details>

<details>
<summary>Restore Specific Components</summary>

```bash
caracal backup restore backup.tar.gz \
  --components agents,policies \
  --force
```

</details>

<details>
<summary>Dry Run</summary>

```bash
caracal backup restore backup.tar.gz --dry-run
```

**Output:**
```
DRY RUN - No changes will be made

Backup contents:
  principals: 125 records (would overwrite 125 existing)
  policies:   89 records (would overwrite 89 existing)
  resources:  45 entries (would overwrite 45 existing)
  ledger:     1,234,567 events (would add to existing)
  merkle:    committed (would rebuild)

To proceed: remove --dry-run and add --force
```

</details>

---

## list

List available backups.

```
caracal backup list [OPTIONS]
```

### Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--path` | `-p` | default | Backup directory |
| `--format` | `-f` | table | Output format |

### Examples

<details>
<summary>List Backups</summary>

```bash
caracal backup list
```

**Output:**
```
Available Backups
=================

Directory: ~/.caracal/backups/

Filename                                Created              Size      Components
------------------------------------------------------------------------------------
backup-2024-01-15T103000Z.tar.gz        2024-01-15 10:30     456 MB    all
backup-2024-01-14T103000Z.tar.gz        2024-01-14 10:30     445 MB    all
backup-2024-01-13T103000Z.tar.gz        2024-01-13 10:30     432 MB    all

Total: 3 backups, 1.33 GB
```

</details>

---

## Backup Schedule

| Frequency | Recommended | Retention |
|-----------|:-----------:|-----------|
| Daily | Yes | 7 days |
| Weekly | Yes | 4 weeks |
| Monthly | Yes | 12 months |

### Cron Example

```bash
# Daily backup at 2 AM
0 2 * * * caracal backup create --output /backup/daily/caracal-$(date +\%Y\%m\%d).tar.gz

# Weekly backup on Sunday at 3 AM
0 3 * * 0 caracal backup create --output /backup/weekly/caracal-$(date +\%Y\%m\%d).tar.gz --include-keys
```

---

## See Also

- [Database Commands](./database) - Database management
- [Merkle Commands](./merkle) - Integrity verification
