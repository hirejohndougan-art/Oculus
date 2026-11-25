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
- **The very first time** it then sets up Oculus's database (T-057). It asks for the `postgres` password you chose when installing PostgreSQL (used once, never saved), then your organization's name, the first site's name, and your name, email and the password you'll sign in with. It makes three accounts in PostgreSQL just for Oculus (one of them can only read what the public may see, for the public sites), with long random passwords kept in `%APPDATA%\postgresql\pgpass.conf`, and writes `%APPDATA%\Oculus\desktop.json`. If making the database goes wrong, it removes what it made, so you can simply try again. If a setup answer goes wrong (say the two passwords don't match), the database is kept and the next double-click asks the setup questions again.
- Oculus opens in its own window at the sign-in screen. At your first sign-in you set up two-step sign-in with an authenticator app on your phone.
- **Closing the Oculus window stops Oculus.** The black window behind it is Oculus running; leave it open while you work.
- Starting it again while it's open just opens another window.
- If closing the window ever leaves the black window running, click it and press Ctrl+C to stop Oculus.
- On a Mac, quit the Oculus window with Cmd+Q; closing it isn't enough.

## Your public sites

Oculus also shows each site's public side, the pages visitors will see, on this computer only (T-071).

- When Oculus starts, the black window lists each one, for example `Public site "Digital archive": http://localhost:4781/`.
- In Oculus, the **View public site** button under the site name opens it in your usual web browser.
- Each site keeps its own address (`localhost` and a number) from one start to the next, so you can bookmark it.
- It shows exactly what a visitor would see: nothing that isn't published, and you aren't signed in there. Until the real public pages are built, it's a page with the site's name that says "This public site is being built".
- Nobody else can open it: like the rest of Oculus, it answers only this computer.
- A site you add while Oculus is running gets its public address the next time you start Oculus.

**If you set up Oculus before the public sites came** (the black window says "The public sites aren't set up on this computer yet"): close Oculus, then in a Command Prompt in the Oculus folder run `node packages\api\dist\desktop-database-cli.js` (`npm run desktop:database` on a Mac or Linux). It asks for the `postgres` password once more and adds the read-only account. Then start Oculus as usual.

## Keep these safe

- **Your database.** Oculus backs it up by itself before every update that changes it, into `%APPDATA%\Oculus\backups`. To make a backup any time, in a Command Prompt in the Oculus folder: `npm run db:backup -- C:\path\to\my.oculus-backup` with `set OCULUS_DATABASE_URL=postgresql://oculus_owner@localhost:5432/oculus` first. Copy backups somewhere safe (a USB drive or cloud folder) with a copy of the secret key below.
- **The secret key** in `%APPDATA%\Oculus\secret-key`, made the first time Oculus starts. Two-step sign-in depends on it, and database backups don't include it. Copy it somewhere safe, like a USB drive kept with your backups. Once anyone has set up two-step sign-in, Oculus refuses to start without that key rather than make a new one that would lock everyone out: put it back from your backup. If it's truly lost, ask for help before doing anything else.
- **Your password and recovery codes.** Without email the password reset is the command in "If you forget your password" below, and the recovery codes Oculus shows at your first sign-in are the only way in if you lose your phone. Keep both somewhere safe.

## Updating

Close Oculus first. Then, in the Oculus folder, `git pull`, and double-click `start-oculus.cmd` as usual (it needs the internet for a minute to fetch updates). If the update changes the database, Oculus backs it up first and says where the backup is. If it can't make the backup, it changes nothing and says why. (It finds PostgreSQL's backup tools in `C:\Program Files\PostgreSQL`; if you installed PostgreSQL somewhere else, set `PG_BIN` to its `bin` folder.)

To undo an update with one of those backups, ask for help: it means making a new, empty database in pgAdmin owned by `oculus_owner`, restoring into it with `npm run db:restore`, and pointing `desktop.json` at it. It rebuilds Oculus and updates the database by itself.

## If you forget your password

In a Command Prompt in the Oculus folder, run `node packages\api\dist\desktop-password-cli.js` (`npm run desktop:password` on a Mac or Linux). It asks for the account's email address and a new password, twice. It's the same reset as the emailed link, with this computer standing in for the email: anyone signed in to that account is signed out, and your two-step sign-in stays as it is, so you still need your phone's code or a recovery code. An account that hasn't set up two-step sign-in yet can only have its password reset by a system admin, from People. So sign in once and set up two-step sign-in right after the first-time setup, and keep your recovery codes.

## What the desktop version doesn't do yet

- **No email unless you set it up.** Oculus can send email through any mail account's SMTP settings (the `OCULUS_SMTP_…` settings in the README, D-085). Without them, "Forgot your password?" and invitations send nothing (see "If you forget your password" above).
- **One computer.** Other people can't reach it. That needs the server version (T-051).
- **Not the finished public website yet.** Each site's public address works on this computer (above), but the real public pages are a later phase.

## Settings

Everything is optional. In `desktop.json`:

- `"databaseUrl"`: the database account Oculus works as (or set `OCULUS_DATABASE_URL`, which wins and is then used for everything).
- `"ownerDatabaseUrl"`: the account that owns the database, used only to update it and check it at start (or `OCULUS_DATABASE_OWNER_URL`).
- `"backupBeforeUpdate"`: `false` to skip the backup before an update changes the database (not recommended).
- `"publicDatabaseUrl"`: the read-only account the public sites use (or `OCULUS_PUBLIC_DATABASE_URL`).
- `"port"`: the port Oculus uses on this computer (default 4780; another free one if that's taken).
- `"publicPorts"`: each site's public port, by site ID. Oculus fills this in itself (from 4781 up) and keeps it; change a number only if another program needs that port.

Other settings: `OCULUS_DESKTOP_HOME` moves the settings folder (only to a folder no one else on the computer can open, since the secret key lives there), `OCULUS_DESKTOP_BROWSER` names the browser to open, and `OCULUS_SECRET_KEY` replaces the key file.
