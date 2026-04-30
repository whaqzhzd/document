import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const outputDir = path.join(projectRoot, 'rust-server', 'assets');
const tempDir = path.join(outputDir, '.tmp');
const archivePath = path.join(tempDir, 'document-dist.tar');
const metadataPath = path.join(outputDir, 'document-dist.json');

const TAR_BLOCK_SIZE = 512;

function normalizeEntryPath(entryPath) {
  return entryPath.split(path.sep).join('/');
}

function writeString(buffer, offset, length, value) {
  buffer.write(value.slice(0, length), offset, length, 'utf8');
}

function writeOctal(buffer, offset, length, value) {
  const octal = value.toString(8);
  const padded = octal.padStart(length - 1, '0');
  buffer.write(`${padded}\0`, offset, length, 'ascii');
}

function createTarHeader(name, stats, typeflag = '0', size = stats.size) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, typeflag === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(stats.mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, typeflag);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');

  let checksum = 0;
  for (const byte of header.values()) {
    checksum += byte;
  }
  const checksumValue = checksum.toString(8).padStart(6, '0');
  header.write(`${checksumValue}\0 `, 148, 8, 'ascii');

  return header;
}

async function collectEntries(rootDir, currentDir = rootDir) {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const entries = [];
  for (const dirent of dirents) {
    const absolutePath = path.join(currentDir, dirent.name);
    const relativePath = normalizeEntryPath(path.relative(rootDir, absolutePath));
    const stats = await fs.stat(absolutePath);

    if (dirent.isDirectory()) {
      entries.push({
        type: 'directory',
        absolutePath,
        relativePath: `${relativePath}/`,
        stats,
      });
      entries.push(...(await collectEntries(rootDir, absolutePath)));
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    entries.push({
      type: 'file',
      absolutePath,
      relativePath,
      stats,
    });
  }

  return entries;
}

async function createTarArchive(rootDir, destinationPath) {
  const entries = await collectEntries(rootDir);
  const output = [];

  for (const entry of entries) {
    if (entry.relativePath.length > 100) {
      throw new Error(`Tar entry path exceeds 100 chars: ${entry.relativePath}`);
    }

    if (entry.type === 'directory') {
      output.push(createTarHeader(entry.relativePath, entry.stats, '5', 0));
      continue;
    }

    const fileBuffer = await fs.readFile(entry.absolutePath);
    output.push(createTarHeader(entry.relativePath, entry.stats, '0', fileBuffer.length));
    output.push(fileBuffer);

    const remainder = fileBuffer.length % TAR_BLOCK_SIZE;
    if (remainder !== 0) {
      output.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
    }
  }

  output.push(Buffer.alloc(TAR_BLOCK_SIZE, 0));
  output.push(Buffer.alloc(TAR_BLOCK_SIZE, 0));

  const archive = Buffer.concat(output);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, archive);

  return { archive, entries };
}

async function main() {
  const distStats = await fs.stat(distDir).catch(() => null);
  if (!distStats?.isDirectory()) {
    throw new Error(`dist directory not found: ${distDir}`);
  }

  const { archive, entries } = await createTarArchive(distDir, archivePath);
  const hash = crypto.createHash('sha256').update(archive).digest('hex');

  const metadata = {
    assetHash: hash,
    tarSize: archive.length,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(`Created Rust asset staging archive: ${archivePath}`);
  console.log(`Asset hash: ${hash}`);
}

main().catch((error) => {
  console.error('[package_dist_for_rust] Failed:', error);
  process.exit(1);
});
