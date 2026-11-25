# Running Oculus on your own computer

Oculus is a web app, but you can run it on one computer and use it in its own window. Nothing goes on the internet. Your records stay in a PostgreSQL database on that computer (D-088).

These steps are for Windows 11. On a Mac or Linux they are the same, except that in a terminal in the Oculus folder you run `npm ci && npm run build`, then `npm run desktop:database` once, then `npm run desktop` each time.

## What you need, once

1. **Node.js 22 or newer** (26 is best) from https://nodejs.org/, and **Git** from https://git-scm.com/.
2. **PostgreSQL 15 or newer** from https://www.postgresql.org/download/windows/ (the EDB installer, about 10 minutes). It asks you to choose a password for the `postgres` account. Write it down; you need it once, below.
3. **Edge or Chrome.** Windows 11 already has Edge. Oculus opens in an Edge window with no tabs or address bar.

## Get Oculus, once

In a Command Prompt:

```
git clone https://github.com/hirejohndougan-art/Oculus.git
```

That makes an `Oculus` folder wherever the Command Prompt was (usually your user folder).

## Start Oculus

Double-click `scripts\start-oculus.cmd` in the Oculus folder. To make a desktop icon, right-click it and choose **Show more options › Send to › Desktop (create shortcut)**.

- The first time, and after each update, it installs and builds Oculus first (a few minutes).
- **The very first time** it then sets up Oculus's database (T-057). It asks for the `postgres` password you chose when installing PostgreSQL (used once, never saved), then your organization's name, the first site's name, and your name, email and the password you'll sign in with. It makes two accounts in PostgreSQL just for Oculus, with long random passwords kept in `%APPDATA%\postgresql\pgpass.conf`, and writes `%APPDATA%\Oculus\desktop.json`. If making the database goes wrong, it removes what it made, so you can simply try again. If a setup answer goes wrong (say the two passwords don't match), the database is kept and the next double-click asks the setup questions again.
- Each start also checks access restrictions (T-034f): records whose restriction ended are put back on the public site, and records a new restriction or unsigned deed holds back are taken off it. Each change shows in the record's history.
- Oculus opens in its own window at the sign-in screen. At your first sign-in you set up two-step sign-in with an authenticator app on your phone.
- **Closing the Oculus window stops Oculus.** The black window behind it is Oculus running; leave it open while you work.
- Starting it again while it's open just opens another window.
- If closing the window ever leaves the black window running, click it and press Ctrl+C to stop Oculus.
- On a Mac, quit the Oculus window with Cmd+Q; closing it isn't enough.

## Keep these safe

- **Your database.** Oculus backs it up by itself before every update that changes it, into `%APPDATA%\Oculus\backups`. To make a backup any time, in a Command Prompt in the Oculus folder: `npm run db:backup -- C:\path\to\my.oculus-backup` with `set OCULUS_DATABASE_URL=postgresql://oculus_owner@localhost:5432/oculus` first. Copy backups somewhere safe (a USB drive or cloud folder) with a copy of the secret key below.
- **The secret key** in `%APPDATA%\Oculus\secret-key`, made the first time Oculus starts. Two-step sign-in depends on it, and database backups don't include it. Copy it somewhere safe, like a USB drive kept with your backups. Once anyone has set up two-step sign-in, Oculus refuses to start without that key rather than make a new one that would lock everyone out: put it back from your backup. If it's truly lost, ask for help before doing anything else.
- **Your files.** Photos, scans and other files you add to records are kept in `%APPDATA%\Oculus\files` (or the folder `OCULUS_FILES_DIR` names), tied to your database by a small `.oculus-store-id` file there. Database backups don't include them: copy the whole folder along with each backup, and restore both together (D-086). Oculus never deletes stored files on its own: removing a file from a record keeps its bytes. A system manager can free the space of removed files under System settings, Removed files ("Clean up removed files"): a file removed at least 7 days ago and not used since goes to a trash folder, and a later step at least a day after that deletes it; uploading the same file again brings it back. It never takes a file any database has used since it was removed, or while another Oculus database uses the folder. Two cases it can't guard against, so avoid them: a file-level copy of the whole PostgreSQL server run on the folder while the original stays stopped for more than a day can delete files that copy removed; and a database restored on its own may list files cleaned up after its backup was taken. Always restore the files folder from the same backup as the database. After upgrading PostgreSQL (pg_upgrade, or a dump and restore into a new version) or moving the database to another server, cleaning up stops with "The files folder names another database": stop every other Oculus that uses the folder and run `npm run files:adopt` (it waits until the folder has been quiet for three hours). Files removed before the adopt are then kept for good; only later removals are cleaned up. Adopt only the database that really is the folder's own, with every other one stopped for good: any copy can adopt once the real one has been stopped for three hours, and if the real one then stays stopped for about eight days, that copy's cleaning up can remove files the real one still lists. Cleaning up also needs Oculus's database role to read the server's identity. PostgreSQL allows that by default, and `npm run desktop:database` grants it anyway; if setup printed a line saying purging will answer `identity_unknown`, have a superuser run the `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO …` it shows, in Oculus's database. Nothing is cleaned up on a timer unless `OCULUS_FILES_AUTO_PURGE=on`. Restore the database and the folder from the same backup: a database restored alone doesn't list files added after its backup (they are still in the folder), and a folder restored alone lacks the files added since it was copied. After a restore Oculus may log the warning `files_shared_or_restored` (it can't always tell); it is harmless and deletes nothing, and until it is cleared nothing is cleaned up. Once you are sure no other Oculus uses the folder, `npm run files:adopt` (with `OCULUS_DATABASE_URL` and `OCULUS_FILES_DIR` set to Oculus's database and this folder, and Oculus stopped for three hours first) clears it; it deletes nothing either.
- **Your password and recovery codes.** Without email the password reset is the command in "If you forget your password" below, and the recovery codes Oculus shows at your first sign-in are the only way in if you lose your phone. Keep both somewhere safe.

## Updating

Close Oculus first. Then, in the Oculus folder, `git pull`, and double-click `start-oculus.cmd` as usual (it needs the internet for a minute to fetch updates). If the update changes the database, Oculus backs it up first and says where the backup is. If it can't make the backup, it changes nothing and says why. (It finds PostgreSQL's backup tools in `C:\Program Files\PostgreSQL`; if you installed PostgreSQL somewhere else, set `PG_BIN` to its `bin` folder.)

To undo an update with one of those backups, ask for help: it means making a new, empty database in pgAdmin owned by `oculus_owner`, restoring into it with `npm run db:restore`, and pointing `desktop.json` at it. It rebuilds Oculus and updates the database by itself.

## If you forget your password

In a Command Prompt in the Oculus folder, run `node packages\api\dist\desktop-password-cli.js` (`npm run desktop:password` on a Mac or Linux). It asks for the account's email address and a new password, twice. It's the same reset as the emailed link, with this computer standing in for the email: anyone signed in to that account is signed out, and your two-step sign-in stays as it is, so you still need your phone's code or a recovery code. An account that hasn't set up two-step sign-in yet can only have its password reset by a system admin, from People. So sign in once and set up two-step sign-in right after the first-time setup, and keep your recovery codes.

## What the desktop version doesn't do yet

- **No email unless you set it up.** Oculus can send email through any mail account's SMTP settings (the `OCULUS_SMTP_…` settings in the README, D-085). Without them, "Forgot your password?" and invitations send nothing (see "If you forget your password" above).
- **One computer.** Other people can't reach it. That needs the server version (T-051).
- **No public website yet.** That's a later phase.

## Settings

Everything is optional. In `desktop.json`:

- `"databaseUrl"`: the database account Oculus works as (or set `OCULUS_DATABASE_URL`, which wins and is then used for everything).
- `"ownerDatabaseUrl"`: the account that owns the database, used only to update it and check it at start (or `OCULUS_DATABASE_OWNER_URL`).
- `"backupBeforeUpdate"`: `false` to skip the backup before an update changes the database (not recommended).
- `"port"`: the port Oculus uses on this computer (default 4780; another free one if that's taken).

Other settings: `OCULUS_DESKTOP_HOME` moves the settings folder (only to a folder no one else on the computer can open, since the secret key lives there), `OCULUS_DESKTOP_BROWSER` names the browser to open, and `OCULUS_SECRET_KEY` replaces the key file.
