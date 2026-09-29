const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const userscript = fs.readFileSync("toggl2plus4u.user.js", "utf8");
const declarations = userscript.slice(0, userscript.indexOf("(async function () {"));
const context = {
  GM_addStyle: function () {
  },
  GM_xmlhttpRequest: function () {
  },
  setTimeout: setTimeout,
  URL: URL
};
vm.runInNewContext(`${declarations}
globalThis.toWtmSubject = toWtmSubject;
globalThis.DateUtils = DateUtils;
globalThis.TimeEntry = TimeEntry;
globalThis.WorkDescription = WorkDescription;
globalThis.Toggl = Toggl;
globalThis.Plus4uWtm = Plus4uWtm;
globalThis.Jira4U = Jira4U;
globalThis.gmRequest = typeof gmRequest === "function" ? gmRequest : undefined;
globalThis.isPlus4uOverlap = typeof isPlus4uOverlap === "function" ? isPlus4uOverlap : undefined;
globalThis.hasExactPlus4uMatch = typeof hasExactPlus4uMatch === "function" ? hasExactPlus4uMatch : undefined;
globalThis.createOperationLock = typeof createOperationLock === "function" ? createOperationLock : undefined;
`, context);

function finishedEntry(overrides) {
  return new context.TimeEntry(Object.assign({
    id: 1,
    start: "2026-09-29T08:07:00",
    stop: "2026-09-29T09:08:00",
    duration: 3660,
    description: "ABC-1 Implement reporting"
  }, overrides));
}

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

test("rejects a time entry without a project", function () {
  assert.throws(() => context.toWtmSubject(null), /no Toggl project/i);
  assert.throws(() => context.toWtmSubject("  "), /no Toggl project/i);
});

test("parses the report interval as local days", function () {
  const start = context.DateUtils.toStartDate("2026-09-28");
  const end = context.DateUtils.toEndDate("2026-09-28");
  assert.equal(start.getTime(), new Date(2026, 8, 28, 0, 0, 0, 0).getTime());
  assert.equal(end.getTime(), new Date(2026, 8, 28, 23, 59, 59, 0).getTime());
});

test("reads a Jira key only from the start of the description", function () {
  assert.equal(context.WorkDescription.parse("ABC-1 Implement reporting").issueKey, "ABC-1");
  assert.equal(context.WorkDescription.parse("Review ABC-1").issueKey, null);
});

test("treats a time entry without a description as not related to Jira", function () {
  const entry = finishedEntry({description: undefined});
  assert.equal(entry.isJiraTask(), false);
});

test("reports to Jira only after Plus4U is confirmed and the worklog check succeeded", function () {
  const entry = finishedEntry();
  assert.equal(typeof entry.canReportToJira, "function");
  assert.equal(entry.canReportToJira(), false);
  entry.setLoggedToPlus4u();
  assert.equal(entry.canReportToJira(), true);
  entry.markJiraCheckUnknown();
  assert.equal(entry.canReportToJira(), false);
});

test("recognizes a Plus4U overlap from uuAppErrorMap", function () {
  assert.equal(typeof context.isPlus4uOverlap, "function");
  assert.equal(context.isPlus4uOverlap({
    responseText: JSON.stringify({
      uuAppErrorMap: {
        "uu-specialistwtm-main/createTimesheetItem/timesheetOverlap": {message: "Overlapping item."}
      }
    })
  }), true);
  assert.equal(context.isPlus4uOverlap({
    responseText: JSON.stringify({
      uuAppErrorMap: {
        "uu-specialistwtm-main/createTimesheetItem/invalidDtoIn": {message: "DtoIn is not valid."}
      }
    })
  }), false);
});

test("does not request rounding for a running timer", async function () {
  const calls = [];
  context.GM_xmlhttpRequest = function (options) {
    calls.push(options);
  };
  const running = new context.TimeEntry({
    id: 2,
    start: "2026-09-29T06:07:00Z",
    stop: null,
    duration: -1,
    description: "work"
  });
  const result = await Promise.race([
    new context.Toggl().roundTimeEntry(running).then(() => "settled"),
    new Promise(resolve => setTimeout(() => resolve("pending"), 50))
  ]);
  assert.equal(result, "settled");
  assert.equal(calls.length, 0);
});

test("finishes rounding without a request when the rounded duration is zero", async function () {
  const calls = [];
  context.GM_xmlhttpRequest = function (options) {
    calls.push(options);
  };
  const entry = new context.TimeEntry({
    id: 3,
    start: "2026-09-29T08:07:00",
    stop: "2026-09-29T08:07:30",
    duration: 30,
    description: "work"
  });
  const result = await Promise.race([
    new context.Toggl().roundTimeEntry(entry).then(() => "settled"),
    new Promise(resolve => setTimeout(() => resolve("pending"), 50))
  ]);
  assert.equal(result, "settled");
  assert.equal(calls.length, 0);
});

test("applies rounding only after Toggl accepts it", async function () {
  const entry = finishedEntry({id: 5});
  const originalStart = entry.start.getTime();
  let request;
  context.GM_xmlhttpRequest = function (options) {
    request = options;
  };
  const toggl = new context.Toggl();
  const rejected = toggl.roundTimeEntry(entry);
  assert.equal(entry.start.getTime(), originalStart);
  request.onload({status: 500, responseText: "no"});
  await assert.rejects(rejected);
  assert.equal(entry.start.getTime(), originalStart);

  let acceptedRequest;
  context.GM_xmlhttpRequest = function (options) {
    acceptedRequest = options;
  };
  const accepted = toggl.roundTimeEntry(entry);
  acceptedRequest.onload({status: 200, responseText: "{}"});
  await accepted;
  assert.notEqual(entry.start.getTime(), originalStart);
});

test("reuses a Plus4U token without another login", async function () {
  const wtm = new context.Plus4uWtm();
  wtm._token = "existing-token";
  let calls = 0;
  context.GM_xmlhttpRequest = function () {
    calls++;
  };
  assert.equal(await wtm._fetchToken(), "existing-token");
  assert.equal(calls, 0);
});

test("does not replace a missing Plus4U token with null", async function () {
  const wtm = new context.Plus4uWtm();
  context.GM_xmlhttpRequest = function (options) {
    options.onload({status: 200, finalUrl: "https://uuapp.plus4u.net/callback?error=login_required"});
  };
  await assert.rejects(wtm._fetchToken(), /token is missing/i);
  assert.equal(wtm._token, null);
});

test("loads every page of a Jira worklog", async function () {
  context.GM_xmlhttpRequest = function (options) {
    const startAt = Number(new URL(options.url).searchParams.get("startAt") || 0);
    const worklogs = startAt === 0
        ? [{started: "2026-09-29T08:00:00.000+0200", timeSpentSeconds: 900, comment: "a"}]
        : [{started: "2026-09-29T09:00:00.000+0200", timeSpentSeconds: 900, comment: "b"}];
    options.onload({status: 200, responseText: JSON.stringify({startAt, total: 2, worklogs})});
  };
  const logs = await new context.Jira4U().loadIssueWorklog("ABC-1");
  assert.equal(logs.length, 2);
});

test("matches an existing Plus4U entry only by time", function () {
  const entry = finishedEntry();
  entry.project = "https://uuapp.plus4u.net/new-project";
  entry.category = "development";
  const renamedProject = finishedEntry();
  renamedProject.project = "OLD-PROJECT";
  renamedProject.category = "meeting";
  renamedProject.description = "Different work";
  const longer = finishedEntry();
  longer.stop = new Date(entry.stop.getTime() + 30 * 60 * 1000);
  assert.equal(entry.equalsPlus4u(renamedProject), true);
  assert.equal(entry.equalsPlus4u(longer), false);
});

test("matches a Jira worklog by time and issue key", function () {
  const entry = finishedEntry();
  const rewritten = finishedEntry();
  rewritten.description = "ABC-1 Something else";
  rewritten.workDescription = new context.WorkDescription("ABC-1", "Something else");
  const otherIssue = finishedEntry();
  otherIssue.workDescription = new context.WorkDescription("XYZ-2", "Implement reporting");
  otherIssue.description = entry.description;
  assert.equal(entry.equalsJira(rewritten), true);
  assert.equal(entry.equalsJira(otherIssue), false);
});

test("accepts a Plus4U overlap only when one entry has the same work", function () {
  const entry = finishedEntry();
  entry.project = "https://uuapp.plus4u.net/new-project";
  const stored = finishedEntry();
  stored.project = "OLD-PROJECT";
  stored.category = "meeting";
  const secondStored = finishedEntry();
  secondStored.project = "OLD-PROJECT";
  const differentWork = finishedEntry();
  differentWork.description = "Different work";
  const differentTime = finishedEntry();
  differentTime.stop = new Date(entry.stop.getTime() + 30 * 60 * 1000);
  assert.equal(context.hasExactPlus4uMatch(entry, [stored]), true);
  assert.equal(context.hasExactPlus4uMatch(entry, [stored, secondStored]), false);
  assert.equal(context.hasExactPlus4uMatch(entry, [differentWork]), true);
  assert.equal(context.hasExactPlus4uMatch(entry, [differentTime]), false);
});

test("runs only one reporting operation at a time", async function () {
  assert.equal(typeof context.createOperationLock, "function");
  const lock = context.createOperationLock();
  let release;
  const gate = new Promise(function (resolve) {
    release = resolve;
  });
  const first = lock.run(function () {
    return gate;
  });
  assert.equal(await lock.run(function () {
    return "second";
  }), false);
  release();
  assert.equal(await first, true);
  assert.equal(await lock.run(function () {
    return "third";
  }), true);
});

test("times out a request that never finishes", async function () {
  let options;
  context.GM_xmlhttpRequest = function (request) {
    options = request;
  };
  const pending = context.gmRequest({method: "GET", url: "https://example.test/slow"});
  assert.equal(options.timeout, 30000);
  options.ontimeout();
  await assert.rejects(pending, /timed out/i);
});

test("loads each Toggl project only once", async function () {
  const urls = [];
  context.GM_xmlhttpRequest = function (options) {
    urls.push(options.url);
    if (options.url.endsWith("/api/v9/me")) {
      options.onload({status: 200, responseText: JSON.stringify({default_workspace_id: 9})});
      return;
    }
    options.onload({status: 200, responseText: JSON.stringify({id: 4, name: "Project"})});
  };
  const toggl = new context.Toggl();
  const entry = finishedEntry();
  entry.pid = 4;
  const first = await toggl.loadProject(entry);
  const second = await toggl.loadProject(entry);
  assert.equal(first.name, "Project");
  assert.equal(second, first);
  assert.equal(urls.filter(url => url.includes("/projects/")).length, 1);
});

test("loads each Jira worklog only once and refreshes it after logging", async function () {
  let reads = 0;
  context.GM_xmlhttpRequest = function (options) {
    if (options.method === "GET") {
      reads++;
    }
    options.onload({status: 200, responseText: JSON.stringify({total: 0, worklogs: []})});
  };
  const jira = new context.Jira4U();
  await jira.loadIssueWorklog("ABC-1");
  await jira.loadIssueWorklog("ABC-1");
  assert.equal(reads, 1);
  await jira.logWork(finishedEntry());
  await jira.loadIssueWorklog("ABC-1");
  assert.equal(reads, 2);
});

test("refreshes an expired Plus4U token once", async function () {
  const authorizations = [];
  context.GM_xmlhttpRequest = function (options) {
    if (String(options.url).includes("oidc/auth")) {
      options.onload({
        status: 200,
        finalUrl: "https://uuapp.plus4u.net/callback#id_token=fresh-token"
      });
      return;
    }
    authorizations.push(options.headers.Authorization);
    options.onload({
      status: authorizations.length === 1 ? 401 : 200,
      responseText: authorizations.length === 1 ? "expired" : "{}"
    });
  };
  const entry = finishedEntry();
  entry.project = "UNI-BT:APP";
  const wtm = new context.Plus4uWtm();
  wtm._token = "old-token";
  await wtm.logWorkItem(entry);
  assert.deepEqual(authorizations, ["Bearer old-token", "Bearer fresh-token"]);
});
