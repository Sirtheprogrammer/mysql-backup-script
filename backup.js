const { Storage } = require('megajs');
const cron = require('node-cron');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();

class MySQLMegaBackup {
  constructor() {
    const envHost = (process.env.DB_HOST || '').trim();
    const envSocket = (process.env.DB_SOCKET || '').trim();
    const parsedPort = parseInt(process.env.DB_PORT, 10);

    this.config = {
      db: {
        host: envHost || '127.0.0.1',
        port: Number.isFinite(parsedPort) ? parsedPort : 3306,
        socket: envSocket || null,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        name: process.env.DB_NAME
      },
      mega: {
        email: process.env.MEGA_EMAIL,
        password: process.env.MEGA_PASSWORD,
        authCode: process.env.MEGA_AUTH_CODE || null
      },
      backup: {
        retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS) || 7,
        schedule: process.env.BACKUP_TIME || '0 0 * * *',
        dir: process.env.BACKUP_DIR || './backups',
        timezone: process.env.TIMEZONE || 'UTC'
      }
    };

    this.megaStorage = null;
    this.backupFolder = null;
  }

  getDumpConnectionArgs() {
    if (this.config.db.socket) {
      return [
        '--protocol=SOCKET',
        `--socket=${this.config.db.socket}`
      ];
    }

    const host = this.config.db.host === 'localhost'
      ? '127.0.0.1'
      : this.config.db.host;

    return [
      '--protocol=TCP',
      '-h', host,
      '-P', String(this.config.db.port)
    ];
  }

  validateConfig() {
    const required = {
      "MEGA_EMAIL":    this.config.mega.email,
      "MEGA_PASSWORD": this.config.mega.password,
      "DB_USER":       this.config.db.user,
      "DB_NAME":       this.config.db.name
      // DB_PASSWORD is optional — omit it for socket auth or ~/.my.cnf logins
    };
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `Missing required config variables: ${missing.join(", ")}\n` +
        "Check that your .env file exists in the same directory as backup.js."
      );
    }
  }

  async initialize() {
    try {
      this.validateConfig();
      await fs.ensureDir(this.config.backup.dir);

      console.log('🔌 Connecting to MEGA.nz...');
      this.megaStorage = new Storage({
        email: this.config.mega.email,
        password: this.config.mega.password,
        userAgent: 'MySQLBackup/1.0'
        // autologin defaults to true — needed so the file tree (root) is
        // fetched after login. With autologin: false, root stays undefined.
      });

      // Handle 2FA if needed
      this.megaStorage.on('verify', () => {
        if (this.config.mega.authCode) {
          this.megaStorage.login(this.config.mega.authCode);
        } else {
          console.error('❌ 2FA required but no auth code provided');
          process.exit(1);
        }
      });

      await this.megaStorage.ready;
      console.log('✅ Connected to MEGA.nz successfully');

      await this.ensureBackupFolder();

    } catch (error) {
      console.error('❌ Initialization failed:', error.message);
      throw error;
    }
  }

  async ensureBackupFolder() {
    try {
      // FIX: children is a synchronous array property, not a Promise
      const files = this.megaStorage.root.children || [];
      this.backupFolder = files.find(file => file.name === 'mysql-backups' && file.directory);

      if (!this.backupFolder) {
        console.log('📁 Creating backup folder on MEGA...');
        this.backupFolder = await this.megaStorage.root.mkdir('mysql-backups');
      }
    } catch (error) {
      console.error('❌ Failed to create/access backup folder:', error.message);
      throw error;
    }
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${this.config.db.name}_backup_${timestamp}.sql`;
    const localPath = path.join(this.config.backup.dir, filename);
    const compressedPath = `${localPath}.gz`;

    console.log(`\n🗄️  Starting backup: ${filename}`);

    try {
      await this.dumpDatabase(localPath);
      await this.compressFile(localPath, compressedPath);
      await this.uploadToMega(compressedPath, `${filename}.gz`);
      await this.cleanupLocalFiles([localPath, compressedPath]);
      await this.cleanupOldBackups();

      console.log(`✅ Backup completed successfully: ${filename}.gz`);
      return true;

    } catch (error) {
      console.error('❌ Backup failed:', error.message);
      await this.cleanupLocalFiles([localPath, compressedPath]).catch(() => {});
      throw error;
    }
  }

  isEventSchedulerDisabledError(stderrOutput) {
    return /Couldn't execute 'show events'/.test(stderrOutput) &&
      /event scheduler is disabled \(1577\)/i.test(stderrOutput);
  }

  isMysqlProcMismatchError(stderrOutput) {
    return /SHOW FUNCTION STATUS WHERE Db =/.test(stderrOutput) &&
      /Column count of mysql\.proc is wrong/i.test(stderrOutput) &&
      /Please use mysql_upgrade to fix this error \(1558\)/i.test(stderrOutput);
  }

  async dumpDatabase(outputPath) {
    const dumpOptions = {
      includeEvents: true,
      includeRoutines: true
    };

    while (true) {
      try {
        await this.runDumpProcess(outputPath, dumpOptions);
        return;
      } catch (error) {
        const stderrOutput = error.stderrOutput || '';

        if (dumpOptions.includeEvents && this.isEventSchedulerDisabledError(stderrOutput)) {
          console.warn('⚠️  MySQL event scheduler is disabled; retrying dump without events');
          dumpOptions.includeEvents = false;
          await this.cleanupLocalFiles([outputPath]).catch(() => {});
          continue;
        }

        if (dumpOptions.includeRoutines && this.isMysqlProcMismatchError(stderrOutput)) {
          console.warn('⚠️  MariaDB system tables need upgrade; retrying dump without routines');
          dumpOptions.includeRoutines = false;
          await this.cleanupLocalFiles([outputPath]).catch(() => {});
          continue;
        }

        throw error;
      }
    }
  }

  runDumpProcess(outputPath, { includeEvents, includeRoutines }) {
    return new Promise((resolve, reject) => {
      const dumpArgs = [
        ...this.getDumpConnectionArgs(),
        '-u', this.config.db.user,
        // Only pass -p if a password is configured. Passing an empty -p flag
        // causes mysqldump to prompt interactively and hang.
        ...(this.config.db.password ? [`-p${this.config.db.password}`] : []),
        '--single-transaction',
        ...(includeRoutines ? ['--routines'] : []),
        '--triggers',
        ...(includeEvents ? ['--events'] : []),
        this.config.db.name
      ];

      const writeStream = fs.createWriteStream(outputPath);
      const mysqldump = spawn('mysqldump', dumpArgs);

      mysqldump.stdout.pipe(writeStream);

      let stderrOutput = '';
      mysqldump.stderr.on('data', (data) => {
        stderrOutput += data.toString();
        // Log as info — mysqldump writes warnings here, not just errors
        console.log(`  mysqldump: ${data.toString().trim()}`);
      });

      mysqldump.on('error', (error) => {
        reject(new Error(`Failed to spawn mysqldump: ${error.message}`));
      });

      // FIX: track both write completion and process exit code.
      // Resolving on 'finish' alone misses non-zero exit codes from mysqldump.
      let writeFinished = false;
      let exitCode = null;

      const checkDone = () => {
        if (!writeFinished || exitCode === null) return;

        if (exitCode !== 0) {
          const dumpError = new Error(`mysqldump exited with code ${exitCode}. Stderr: ${stderrOutput.trim()}`);
          dumpError.exitCode = exitCode;
          dumpError.stderrOutput = stderrOutput;
          reject(dumpError);
        } else {
          const disabledFeatures = [];
          if (!includeEvents) disabledFeatures.push('events');
          if (!includeRoutines) disabledFeatures.push('routines');
          const suffix = disabledFeatures.length > 0
            ? ` (without ${disabledFeatures.join(' and ')})`
            : '';
          console.log(`✅ Database dump completed${suffix}`);
          resolve();
        }
      };

      writeStream.on('finish', () => {
        writeFinished = true;
        checkDone();
      });

      writeStream.on('error', (error) => {
        reject(new Error(`Write stream error: ${error.message}`));
      });

      mysqldump.on('close', (code) => {
        exitCode = code;
        checkDone();
      });
    });
  }

  compressFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const zlib = require('zlib');
      const gzip = zlib.createGzip();
      const input = fs.createReadStream(inputPath);
      const output = fs.createWriteStream(outputPath);

      input
        .pipe(gzip)
        .pipe(output)
        .on('finish', () => {
          console.log('🗜️  Compression completed');
          resolve();
        })
        .on('error', reject);
    });
  }

  async uploadToMega(localPath, remoteName) {
    console.log('☁️  Uploading to MEGA.nz...');

    // FIX: use fs.stat to get file size instead of reading entire file into memory
    const { size } = await fs.stat(localPath);

    const uploadStream = this.backupFolder.upload({
      name: remoteName,
      size
    });

    let uploadedBytes = 0;
    const readStream = fs.createReadStream(localPath);

    readStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const progress = ((uploadedBytes / size) * 100).toFixed(2);
      process.stdout.write(`\r⬆️  Upload progress: ${progress}%`);
    });

    await new Promise((resolve, reject) => {
      readStream
        .pipe(uploadStream)
        .on('error', reject)
        .on('complete', (file) => {
          console.log(`\n✅ Uploaded: ${file.name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
          resolve(file);
        });
    });
  }

  async cleanupLocalFiles(paths) {
    for (const filePath of paths) {
      try {
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
        }
      } catch (error) {
        console.warn(`⚠️  Failed to delete ${filePath}:`, error.message);
      }
    }
  }

  async cleanupOldBackups() {
    console.log('🧹 Cleaning up old backups...');

    try {
      // FIX: children is a synchronous array property, not a Promise
      const files = this.backupFolder.children || [];
      const now = new Date();
      const retentionMs = this.config.backup.retentionDays * 24 * 60 * 60 * 1000;

      const oldBackups = files.filter(file => {
        // Filename timestamp was produced by: new Date().toISOString().replace(/[:.]/g, '-')
        // e.g. "2024-01-15T10-30-00-000Z" — dashes in the date are original,
        // dashes in the time replaced colons/dots.
        const match = file.name.match(/backup_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        if (!match) return false;

        // FIX: reconstruct a valid ISO string by only replacing time-part dashes,
        // not the date-part dashes. Old code did .replace(/-/g, ':') on the whole
        // string which corrupted the date (e.g. "2024-01-15" → "2024:01:15").
        const [, datePart, hh, mm, ss] = match;
        const backupDate = new Date(`${datePart}T${hh}:${mm}:${ss}Z`);

        return (now - backupDate) > retentionMs;
      });

      for (const file of oldBackups) {
        await file.delete(true);
        console.log(`🗑️  Deleted old backup: ${file.name}`);
      }

      if (oldBackups.length === 0) {
        console.log('✅ No old backups to delete');
      }

    } catch (error) {
      // Don't throw — cleanup failure shouldn't abort the backup
      console.error('⚠️  Cleanup warning:', error.message);
    }
  }

  startScheduler() {
    const { schedule, timezone } = this.config.backup;

    const runBackup = async (label) => {
      console.log(`\n🗄️  Running ${label} backup...`);
      try {
        await this.createBackup();
      } catch (error) {
        console.error(`❌ ${label} backup failed:`, error.message);
      }
    };

    // Run immediately on launch, then follow the schedule
    runBackup('initial');

    const scheduledTask = cron.schedule(
      schedule,
      () => runBackup('scheduled'),
      { timezone }
    );

    const nextRun = scheduledTask.nextDate?.()?.toISO?.() ?? schedule;
    console.log(`⏰ Scheduler started. Next scheduled backup at: ${nextRun} (${timezone})`);
  }

  async runOnce() {
    await this.initialize();
    await this.createBackup();
    process.exit(0);
  }
}

// Main execution
async function main() {
  const backup = new MySQLMegaBackup();

  if (process.argv.includes('--run-once')) {
    await backup.runOnce();
  } else {
    await backup.initialize();
    backup.startScheduler();

    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down gracefully...');
      process.exit(0);
    });
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
