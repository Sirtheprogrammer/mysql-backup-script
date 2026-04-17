# MySQL MEGA Backup

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-mysqldump-4479A1?logo=mysql&logoColor=white)
![MEGA](https://img.shields.io/badge/Storage-MEGA-D90007?logo=mega&logoColor=white)
![Scheduler](https://img.shields.io/badge/Scheduler-node--cron-0F172A)
![Status](https://img.shields.io/badge/Status-active-16A34A)

Small Node.js tool for backing up a MySQL or MariaDB database to MEGA.nz.

It creates a SQL dump, compresses it to `.gz`, uploads it to a `mysql-backups` folder in MEGA, and removes old backups based on the retention period.

## Features

- Connects to MySQL or MariaDB with TCP or Unix socket settings
- Creates compressed `.sql.gz` backups
- Uploads backups to MEGA.nz
- Runs once or on a cron schedule
- Deletes old remote backups automatically
- Retries without events if the event scheduler is disabled
- Retries without routines if MariaDB system tables are outdated

## Requirements

- Node.js
- `mysqldump` available in your system path
- A running MySQL or MariaDB server
- A MEGA.nz account

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env` with your database and MEGA credentials.

## Configuration

```env
DB_HOST=127.0.0.1
DB_PORT=3306
# DB_SOCKET=/run/mysqld/mysqld.sock
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=your_database_name

MEGA_EMAIL=your_mega_email@example.com
MEGA_PASSWORD=your_mega_password
# MEGA_AUTH_CODE=123456

BACKUP_RETENTION_DAYS=7
BACKUP_TIME=0 0 * * *
BACKUP_DIR=./backups
TIMEZONE=UTC
```

## Usage

Run one backup:

```bash
npm run backup
```

Run the scheduler:

```bash
npm start
```

## Notes

- `DB_HOST=127.0.0.1` forces TCP. Use `DB_SOCKET` only if you want socket-based access.
- If `DB_PASSWORD` is empty, `mysqldump` may print a warning about insecure passwordless login.
- If events are disabled on the server, the backup continues without events.
- If MariaDB routine tables are outdated, the backup continues without routines.

## Output

Backup files use this format:

```text
database_name_backup_YYYY-MM-DDTHH-mm-ss-sssZ.sql.gz
```

They are uploaded to the `mysql-backups` folder in your MEGA account.
