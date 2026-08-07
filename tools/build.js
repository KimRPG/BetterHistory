"use strict";

// 웹 스토어에 올릴 패키지를 만듭니다. (외부 의존성 없음)
//
// 담을 파일은 손으로 적지 않고 **manifest에서 출발해 참조를 따라가며** 모읍니다.
// 목록을 손으로 관리하면 파일을 하나 추가할 때마다 여기도 같이 고쳐야 하는데,
// 안 고쳐도 빌드는 성공하고 Chrome에서만 터집니다. 실제로 예전 zip은 _locales가
// 통째로 빠진 채로 만들어져 있었고, default_locale이 있는 확장은 그 파일이
// 없으면 로드 자체가 거부됩니다.
//
// 그래서 이 스크립트는 만들기 전에 먼저 확인합니다. 빠진 파일, 정의되지 않은
// __MSG__ 키, 저장소에는 있는데 담기지 않은 런타임 파일 — 셋 중 하나라도
// 걸리면 zip을 쓰지 않고 실패합니다.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = "dist";

// 런타임에 필요 없는 것들입니다. 여기 없는 파일이 저장소에 생기면 빌드가
// "담을까 말까"를 묻는 대신 실패합니다. 조용히 빠지는 것보다 낫습니다.
const DEV_ONLY = [
  ".git",
  ".gitignore",
  ".DS_Store",
  "dist",
  "node_modules",
  "package.json",
  "package-lock.json",
  "tests",
  "tools",
  // 개발 문서입니다. 사용자에게 보이는 문구는 _locales와 스토어 등록 정보에
  // 있으므로 패키지에 넣지 않습니다.
  "README.md"
];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

// manifest에서 출발해 참조를 따라갑니다. HTML은 <script src>와 <link href>를,
// 서비스 워커는 importScripts를 각각 한 단계 더 끌어옵니다.
function collectFiles() {
  const manifest = JSON.parse(readText("manifest.json"));
  const files = new Set();
  const pending = [];
  const chromeProvided = [];

  const add = (value, base = ".") => {
    if (typeof value !== "string" || value === "") return;
    // _favicon/*처럼 Chrome이 만들어 주는 경로는 저장소에 파일이 없습니다.
    if (value.includes("*")) {
      chromeProvided.push(value);
      return;
    }
    const resolved = path.posix.normalize(path.posix.join(base, value));
    if (files.has(resolved)) return;
    files.add(resolved);
    pending.push(resolved);
  };

  add("manifest.json");
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) add(file);
    for (const file of entry.css ?? []) add(file);
  }
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) {
    add(icon);
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) add(resource);
  }

  // 문구 파일은 manifest가 이름으로 가리키지 않습니다. _locales 아래를 그대로
  // 담아야 default_locale 말고 다른 언어도 함께 나갑니다.
  for (const locale of listLocales()) {
    add(`_locales/${locale}/messages.json`);
  }

  // MIT 라이선스는 배포물에 함께 실어야 합니다.
  add("LICENSE");

  while (pending.length) {
    const file = pending.shift();
    const base = path.posix.dirname(file);
    if (!exists(file)) continue;

    if (file.endsWith(".html")) {
      for (const reference of readHtmlReferences(readText(file))) {
        add(reference, base);
      }
    } else if (file.endsWith(".js")) {
      for (const reference of readImportScripts(readText(file))) {
        add(reference, base);
      }
    }
  }

  return { manifest, files: [...files].sort(), chromeProvided };
}

function listLocales() {
  const localeDir = path.join(ROOT, "_locales");
  if (!fs.existsSync(localeDir)) return [];
  return fs
    .readdirSync(localeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readHtmlReferences(source) {
  const references = [];
  for (const [, value] of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
    // 바깥 주소와 조각 링크는 담을 파일이 아닙니다.
    if (/^(?:[a-z]+:|\/\/|#)/i.test(value)) continue;
    references.push(value);
  }
  return references;
}

function readImportScripts(source) {
  const references = [];
  for (const [, list] of source.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const [, value] of list.matchAll(/["']([^"']+)["']/g)) {
      references.push(value);
    }
  }
  return references;
}

// 저장소에 있는데 담기지 않은 파일입니다. 콘텐츠 스크립트를 하나 더 만들고
// manifest에 넣는 것을 잊으면 여기서 걸립니다.
function findUnbundled(files) {
  const bundled = new Set(files);
  const found = [];

  const walk = (relativeDir) => {
    const absolute = path.join(ROOT, relativeDir);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = relativeDir === "."
        ? entry.name
        : `${relativeDir}/${entry.name}`;
      if (DEV_ONLY.includes(child) || DEV_ONLY.includes(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(child);
      } else if (!bundled.has(child) && !child.endsWith(".zip")) {
        found.push(child);
      }
    }
  };

  walk(".");
  return found.sort();
}

// Chrome은 __MSG_키__를 default_locale에서 찾습니다. 없으면 확장이 아예
// 로드되지 않으므로, 올리기 전에 여기서 잡습니다.
function checkMessages(manifest) {
  const problems = [];
  const locale = manifest.default_locale;

  if (!locale) {
    if (JSON.stringify(manifest).includes("__MSG_")) {
      problems.push("manifest가 __MSG__를 쓰는데 default_locale이 없습니다");
    }
    return problems;
  }

  const messagesPath = `_locales/${locale}/messages.json`;
  if (!exists(messagesPath)) {
    problems.push(`${messagesPath}이 없습니다 (default_locale: ${locale})`);
    return problems;
  }

  const messages = JSON.parse(readText(messagesPath));
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
    if (!(key in messages)) {
      problems.push(`${messagesPath}에 ${key}가 없습니다`);
    }
  }
  return problems;
}

function verify({ manifest, files }) {
  const problems = [];

  for (const file of files) {
    if (!exists(file)) problems.push(`${file}이 없습니다`);
  }

  problems.push(...checkMessages(manifest));

  for (const locale of listLocales()) {
    const file = `_locales/${locale}/messages.json`;
    try {
      JSON.parse(readText(file));
    } catch (error) {
      problems.push(`${file}을 읽을 수 없습니다: ${error.message}`);
    }
  }

  const version = JSON.parse(readText("package.json")).version;
  if (version !== manifest.version) {
    problems.push(
      `버전이 어긋납니다: manifest ${manifest.version}, package.json ${version}`
    );
  }

  for (const file of findUnbundled(files)) {
    problems.push(`${file}이 어디에서도 참조되지 않아 빠집니다`);
  }

  return problems;
}

// --- zip ---------------------------------------------------------------
// 같은 입력이면 같은 바이트가 나오도록 시각은 DOS 기준 시각(1980-01-01)으로
// 고정합니다. 파일 수정 시각이 섞이면 내용이 같아도 zip이 매번 달라집니다.

const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const raw = fs.readFileSync(path.join(ROOT, file));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 줄어들지 않으면 압축하지 않고 그대로 넣습니다.
    const compress = deflated.length < raw.length;
    const body = compress ? deflated : raw;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 필요한 버전
    local.writeUInt16LE(0x0800, 6); // 파일명은 UTF-8
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // 만든 버전
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(compress ? 8 : 0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function build() {
  const collected = collectFiles();
  const problems = verify(collected);

  if (problems.length) {
    console.error("빌드를 멈춥니다. 올려도 Chrome이 거부하거나 기능이 빠집니다.\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const { manifest, files, chromeProvided } = collected;
  const outputDir = path.join(ROOT, OUTPUT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });

  const output = path.join(outputDir, `better-gesture-${manifest.version}.zip`);
  fs.writeFileSync(output, createZip(files));

  for (const file of files) console.log(`  ${file}`);
  if (chromeProvided.length) {
    console.log(`\nChrome이 제공(파일 없음): ${chromeProvided.join(", ")}`);
  }
  console.log(
    `\n${path.relative(ROOT, output)} — ${files.length}개 파일, ` +
    `${fs.statSync(output).size.toLocaleString()} bytes`
  );
}

module.exports = { collectFiles, findUnbundled, verify, DEV_ONLY };

if (require.main === module) build();
