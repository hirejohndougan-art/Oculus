# Running Oculus on your own computer

Oculus is a web app, but you can run it on one computer and use it in its own window. Nothing goes on the internet. Your records stay in a PostgreSQL database on that computer (D-088).

These steps are for Windows 11. On a Mac or Linux they are the same, except that the commands go in a terminal and you start Oculus with `npm run desktop`.

## What you need, once

1. **Node.js 22 or newer** (26 is best) from https://nodejs.org/, and **Git** from https://git-scm.com/.
2. **PostgreSQL 15 or newer** from https://www.postgresql.org/download/windows/ (the EDB installer, about 10 minutes). It asks you to choose a password for the `postgres` account. Write it down; you need it once, below.
3. **Edge or Chrome.** Windows 11 already has Edge. Oculus opens in an Edge window with no tabs or address bar.

## Make Oculus's database, once

Task T-057 will do this part for you with one command. Until then, it takes four steps:

1. Open **SQL Shell (psql)** from the Start menu. Press Enter at each question until it asks for the password, then type the `postgres` password.
2. Paste these two lines, with a long password of your own in place of `choose-a-long-password`:

   ```sql
   CREATE ROLE oculus LOGIN PASSWORD 'choose-a-long-password';
   CREATE DATABASE oculus OWNER oculus;
   ```

   Type `\q` to leave.
3. Save that password where PostgreSQL looks for it. Make the folder `%APPDATA%\postgresql` and, in it, a text file `pgpass.conf` holding one line:

   ```
   localhost:5432:oculus:oculus:choose-a-long-password
   ```

4. Tell Oculus where its database is. Make the folder `%APPDATA%\Oculus` and, in it, a text file `desktop.json` holding:

   ```json
   { "databaseUrl": "postgresql://oculus@localhost:5432/oculus" }
   ```

   Never put the password in this file; Oculus refuses to start if you do.

In Notepad, choose **Save as type: All files** for both files, or Windows saves them as `pgpass.conf.txt` and `desktop.json.txt` and nothing finds them.

## Get Oculus and set it up, once

In a Command Prompt:

```
git clone https://github.com/hirejohndougan-art/Oculus.git
cd Oculus
npm ci
npm run build
set OCULUS_DATABASE_URL=postgresql://oculus@localhost:5432/oculus
node packages\db\dist\setup-cli.js
```

The last line is `npm run setup` on a Mac or Linux. It asks for your organization's name, the first site's name, and your name, email and password. It runs only once.

## Start Oculus

Double-click `scripts\start-oculus.cmd` in the Oculus folder. To make a desktop icon, right-click it and choose **Show more options › Send to › Desktop (create shortcut)**.

- The first time, and after each update, it installs and builds Oculus first (a few minutes).
- Oculus opens in its own window at the sign-in screen. At your first sign-in you set up two-step sign-in with an authenticator app on your phone.
- **Closing the Oculus window stops Oculus.** The black window behind it is Oculus running; leave it open while you work.
- Starting it again while it's open just opens another window.
- If closing the window ever leaves the black window running, click it and press Ctrl+C to stop Oculus.
- On a Mac, quit the Oculus window with Cmd+Q; closing it isn't enough.

## Keep these safe

- **Your database.** `npm run db:backup -- <file>` makes a backup (see the README).
- **The secret key** in `%APPDATA%\Oculus\secret-key`, made the first time Oculus starts. Two-step sign-in depends on it, and database backups don't include it. Copy it somewhere safe, like a USB drive kept with your backups. Once anyone has set up two-step sign-in, Oculus refuses to start without that key rather than make a new one that would lock everyone out: put it back from your backup. If it's truly lost, ask for help before doing anything else.
- **Your password and recovery codes.** Until email is set up there's no password reset, and the recovery codes Oculus shows at your first sign-in are the only way in if you lose your phone. Keep both somewhere safe.

## Updating

Close Oculus first. Then, in the Oculus folder, `git pull`, and double-click `start-oculus.cmd` as usual (it needs the internet for a minute to fetch updates). It rebuilds Oculus and updates the database by itself.

## What the desktop version doesn't do yet

- **No email.** "Forgot your password?" and invitations don't send anything until email is set up (T-040), so don't forget your password.
- **One computer.** Other people can't reach it. That needs the server version (T-051).
- **No public website yet.** That's a later phase.

## Settings

Everything is optional. In `desktop.json`:

- `"databaseUrl"`: the database (or set `OCULUS_DATABASE_URL`, which wins).
- `"port"`: the port Oculus uses on this computer (default 4780; another free one if that's taken).

Other settings: `OCULUS_DESKTOP_HOME` moves the settings folder (only to a folder no one else on the computer can open, since the secret key lives there), `OCULUS_DESKTOP_BROWSER` names the browser to open, and `OCULUS_SECRET_KEY` replaces the key file.
