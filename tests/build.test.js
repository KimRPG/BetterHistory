"use strict";

// 예전 zip은 _locales가 통째로 빠진 채로 만들어져 있었습니다. default_locale이
// 있는 확장은 그 파일이 없으면 Chrome이 로드 자체를 거부하므로, 올리기 전까지
// 아무도 모릅니다. 담을 목록이 조용히 어긋나는 것을 여기서 잡습니다.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { collectFiles, findUnbundled, verify } = require("../tools/build.js");

const root = path.join(__dirname, "..");

test("빌드가 지금 저장소에서 아무 문제도 찾지 못한다", () => {
  assert.deepEqual(verify(collectFiles()), []);
});

test("manifest가 가리키는 파일은 모두 담긴다", () => {
  const { manifest, files } = collectFiles();
  const bundled = new Set(files);

  const required = [
    "manifest.json",
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => [
      ...(entry.js ?? []),
      ...(entry.css ?? [])
    ]),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];

  for (const file of required) {
    assert.equal(bundled.has(file), true, `${file}이 빠졌습니다`);
  }
});

// _favicon/*은 Chrome이 만들어 주는 경로라 저장소에 파일이 없습니다. 이걸
// 담으려 들면 "없는 파일"로 빌드가 멈춥니다.
test("Chrome이 제공하는 경로는 담을 파일로 세지 않는다", () => {
  const { files, chromeProvided } = collectFiles();

  assert.deepEqual(chromeProvided, ["_favicon/*"]);
  assert.equal(files.some((file) => file.includes("*")), false);
});

// 문구 파일은 manifest가 이름으로 가리키지 않아서 참조를 따라가는 것만으로는
// 절대 걸리지 않습니다. 예전 zip이 빠뜨린 곳이 정확히 여기입니다.
test("네 언어의 문구 파일이 모두 담긴다", () => {
  const bundled = new Set(collectFiles().files);
  const locales = fs
    .readdirSync(path.join(root, "_locales"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.equal(locales.length, 4);
  for (const locale of locales) {
    assert.equal(
      bundled.has(`_locales/${locale}/messages.json`),
      true,
      `${locale} 문구가 빠졌습니다`
    );
  }
});

// HTML은 manifest에 파일 이름만 있고 그 안에서 무엇을 부르는지는 없습니다.
test("팝업이 부르는 스크립트와 스타일까지 따라간다", () => {
  const bundled = new Set(collectFiles().files);

  for (const file of [
    "popup.css",
    "popup.js",
    "shared/i18n.js",
    "shared/settings.js"
  ]) {
    assert.equal(bundled.has(file), true, `${file}이 빠졌습니다`);
  }
});

test("개발용 파일은 담기지 않는다", () => {
  const files = collectFiles().files;

  for (const file of files) {
    assert.equal(file.startsWith("tests/"), false, `${file}이 담겼습니다`);
    assert.equal(file.startsWith("tools/"), false, `${file}이 담겼습니다`);
  }
  assert.equal(files.includes("package.json"), false);
  assert.equal(files.includes("README.md"), false);
  // 배포물에는 라이선스를 함께 실어야 합니다.
  assert.equal(files.includes("LICENSE"), true);
});

// 콘텐츠 스크립트를 하나 더 만들고 manifest에 넣는 것을 잊으면, 빌드는
// 성공하고 Chrome에서만 티가 납니다.
test("저장소에 있는데 담기지 않는 파일을 찾아낸다", () => {
  const { files } = collectFiles();
  assert.deepEqual(findUnbundled(files), []);

  // 파일 하나를 목록에서 빼면 곧바로 걸려야 합니다.
  const withoutWorker = files.filter((file) => file !== "worker.js");
  assert.deepEqual(findUnbundled(withoutWorker), ["worker.js"]);
});
