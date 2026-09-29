const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const userscript = fs.readFileSync("toggl2plus4u.user.js", "utf8");
const declarations = userscript.slice(0, userscript.indexOf("(async function () {"));
const context = {
  GM_addStyle: function () {
  }
};
vm.runInNewContext(`${declarations}\nglobalThis.toWtmSubject = toWtmSubject;`, context);

test("keeps an HTTPS project URI unchanged", function () {
  assert.equal(
      context.toWtmSubject("https://uuapp.plus4u.net/example"),
      "https://uuapp.plus4u.net/example"
  );
});

test("converts a legacy project identifier to a UES URI", function () {
  assert.equal(
      context.toWtmSubject("UNI-BT:USYE.FBCORE/STAGE_4_EXT4"),
      "ues:UNI-BT:USYE.FBCORE/STAGE_4_EXT4"
  );
});

test("keeps an existing UES URI unchanged", function () {
  assert.equal(
      context.toWtmSubject("ues:UNI-BT:USYE.FBCORE/STAGE_4_EXT4"),
      "ues:UNI-BT:USYE.FBCORE/STAGE_4_EXT4"
  );
});
