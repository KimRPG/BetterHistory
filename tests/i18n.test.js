"use strict";

// 없는 키를 부르면 화면에 키 이름이 그대로 뜨고, 쓰지 않는 키는 조용히 쌓입니다.
// 문구가 4개 언어로 흩어져 있으면 사람 눈으로는 둘 다 놓치므로 여기서 잡습니다.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const LOCALES = ["en", "ko", "ja", "zh_CN"];
const REFERENCE_LOCALE = "en";

// 문구를 꺼내 쓰는 곳 전부입니다.
const SOURCE_FILES = [
  "manifest.json",
  "worker.js",
  "popup.html",
  "popup.js",
  "shared/i18n.js",
  "shared/settings.js",
  "content/history-client.js",
  "content/history-menu.js"
];

function readMessages(locale) {
  return JSON.parse(fs.readFileSync(
    path.join(root, "_locales", locale, "messages.json"),
    "utf8"
  ));
}

function readSources() {
  return SOURCE_FILES.map((file) => ({
    file,
    source: fs.readFileSync(path.join(root, file), "utf8")
  }));
}

test("manifest가 기본 언어를 선언한다", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8")
  );

  // _locales가 있으면 default_locale이 없을 때 확장이 아예 로드되지 않습니다.
  assert.equal(LOCALES.includes(manifest.default_locale), true);
  for (const locale of LOCALES) {
    assert.equal(
      fs.existsSync(path.join(root, "_locales", locale, "messages.json")),
      true,
      `${locale} 메시지 파일이 없습니다`
    );
  }
});

test("모든 언어가 같은 키를 같은 형태로 가진다", () => {
  const reference = readMessages(REFERENCE_LOCALE);
  const referenceKeys = Object.keys(reference).sort();
  assert.equal(referenceKeys.length > 0, true);

  for (const locale of LOCALES) {
    const messages = readMessages(locale);
    assert.deepEqual(
      Object.keys(messages).sort(),
      referenceKeys,
      `${locale}의 키 목록이 ${REFERENCE_LOCALE}와 다릅니다`
    );

    for (const [key, entry] of Object.entries(messages)) {
      assert.equal(
        typeof entry.message === "string" && entry.message.trim() !== "",
        true,
        `${locale}의 ${key}가 비어 있습니다`
      );

      // 자리표시자가 빠지면 숫자가 사라진 문장이 그대로 나갑니다.
      const expected = Object.keys(reference[key].placeholders ?? {}).sort();
      assert.deepEqual(
        Object.keys(entry.placeholders ?? {}).sort(),
        expected,
        `${locale}의 ${key} 자리표시자가 다릅니다`
      );
      for (const name of expected) {
        assert.match(
          entry.message,
          new RegExp(`\\$${name}\\$`, "i"),
          `${locale}의 ${key} 문구에 $${name}$가 없습니다`
        );
      }
    }
  }
});

test("소스에서 부르는 키는 모두 정의돼 있다", () => {
  const defined = new Set(Object.keys(readMessages(REFERENCE_LOCALE)));
  const patterns = [
    /\bt\("([A-Za-z0-9_]+)"/g,
    /data-i18n(?:-title)?="([A-Za-z0-9_]+)"/g,
    /__MSG_([A-Za-z0-9_]+)__/g
  ];

  let checked = 0;
  for (const { file, source } of readSources()) {
    for (const pattern of patterns) {
      for (const [, key] of source.matchAll(pattern)) {
        assert.equal(defined.has(key), true, `${file}의 ${key}가 없는 키입니다`);
        checked += 1;
      }
    }
  }
  assert.equal(checked > 0, true);
});

test("정의한 키는 모두 어딘가에서 쓰인다", () => {
  // 상수나 표를 거쳐 쓰이는 키도 있으므로 이름이 등장하는지만 확인합니다.
  const sources = readSources().map(({ source }) => source).join("\n");

  for (const key of Object.keys(readMessages(REFERENCE_LOCALE))) {
    assert.equal(sources.includes(key), true, `${key}를 쓰는 곳이 없습니다`);
  }
});
