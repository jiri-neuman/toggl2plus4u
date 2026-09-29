// ==UserScript==
// @name         Toggl integration with Plus4U and Jira
// @namespace    https://github.com/jiri-neuman/toggl2plus4u
// @version      1.0.0
// @description  Integrates Toggl with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://track.toggl.com/timer*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      plus4u.net
// @connect      jira.unicorn.com
// @connect      toggl.com
// @run-at       document-end
// ==/UserScript==

GM_addStyle(`
    #uniExtToolbar {
        margin: 85px 0 0 15px;
    }

    #uniExtToolbar .inputPanel {
      display: inline-flex;
    }

    #uniExtToolbar .inputPanel div {
      margin: 5px;
    }

    #uniExtToolbar .buttonsPanel {
      display: flex;
    }

    #uniExtToolbar .buttonsPanel div {
      margin: 0 5px 5px 0;
    }

    #uniExtToolbar .buttonsPanel button {
      margin: 10px 0 0 10px;
      padding: 3px;
      border-width: 2px;
      background-color: grey;
    }

    #uniExtToolbar .error {
      color: red;
      font-weight: bold;
    }

    #uniExtToolbar .success {
      color: green;
      font-weight: bold;
    }

    #uniExtToolbar .warning {
      color: orange;
      font-weight: bold;
    }
    
    input[type=checkbox] {
      display: inline;
    }
`);

function toWtmSubject(project) {
  if (typeof project !== "string" || project.trim() === "") {
    throw new Error("Time entry has no Toggl project.");
  }
  const subject = project.trim();
  return /^(?:ues:|[a-z][a-z0-9+.-]*:\/\/)/i.test(subject) ? subject : `ues:${subject}`;
}

function isPlus4uOverlap(error) {
  const text = error && error.responseText;
  if (typeof text !== "string") {
    return false;
  }
  try {
    const map = JSON.parse(text).uuAppErrorMap;
    if (!map || typeof map !== "object") {
      return false;
    }
    return Object.keys(map).some(function (key) {
      const detail = map[key] || {};
      return /overlap/i.test(key) || /overlap/i.test(detail.message || "");
    });
  } catch (e) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

function gmRequest(options, attempt) {
  const retry = attempt || 0;
  return new Promise(function (resolve, reject) {
    GM_xmlhttpRequest({
      method: options.method,
      url: options.url,
      headers: options.headers,
      data: options.data,
      onload: function (response) {
        if (response.status === 429 && retry < 3) {
          const timeout = 500 + Math.floor(Math.random() * 1000);
          setTimeout(function () {
            gmRequest(options, retry + 1).then(resolve, reject);
          }, timeout);
          return;
        }
        if (response.status >= 200 && response.status < 300) {
          resolve(response);
          return;
        }
        reject(response);
      },
      timeout: 30000,
      onerror: reject,
      ontimeout: function () {
        reject(new Error("Request timed out."));
      },
      onabort: function () {
        reject(new Error("Request was aborted."));
      }
    });
  });
}

function hasExactPlus4uMatch(entry, entries) {
  if (!Array.isArray(entries)) {
    return false;
  }
  return entries.filter(other => entry.equalsPlus4u(other)).length === 1;
}

function createOperationLock() {
  let inProgress = false;
  return {
    async run(action) {
      if (inProgress) {
        return false;
      }
      inProgress = true;
      try {
        await action();
        return true;
      } finally {
        inProgress = false;
      }
    }
  };
}

function setHtml(id, html) {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = html;
  }
}

class Plus4uWtm {

  constructor() {
    this._token = null;
    this._initializing = false;
    this._wtmUrl = "https://uuapp.plus4u.net/uu-specialistwtmg01-main/99923616732453117-8031926f783d4aaba733af73c1974840";
  }

  async logWorkItem(timeEntry) {
    let dtoIn = {};
    dtoIn.datetimeFrom = timeEntry.start.toISOString();
    dtoIn.datetimeTo = timeEntry.stop.toISOString();
    dtoIn.subject = toWtmSubject(timeEntry.project);
    if (timeEntry.category) {
      dtoIn.category = timeEntry.category;
    }
    dtoIn.description = timeEntry.description;

    const requestData = JSON.stringify(dtoIn);
    console.info(`Sending time entry to Plus4U: ${requestData}`);
    return this._authorizedRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://uuapp.plus4u.net",
        "Referer": this._wtmUrl
      },
      data: requestData,
      url: `${this._wtmUrl}/createTimesheetItem`
    });
  }

  async loadTsr(interval) {
    const response = await this._getTsr(interval);
    const dtoOut = JSON.parse(response.responseText);
    const items = Array.isArray(dtoOut.timesheetItemList) ? dtoOut.timesheetItemList : [];
    return items.map(entry => TimeEntry.fromPlus4u(entry));
  }

  _getTsr(interval) {
    console.log(`Fetching time sheet reports from Plus4U WTM.`);
    const dtoIn = {
      datetimeFrom: interval.start,
      datetimeTo: interval.end
    }
    return this._authorizedRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://uuapp.plus4u.net",
        "Referer": this._wtmUrl
      },
      data: JSON.stringify(dtoIn),
      url: `${this._wtmUrl}/listWorkerTimesheetItemsByTime`
    });
  }

  async _authorizedRequest(options, allowRefresh) {
    const token = await this._fetchToken();
    try {
      return await gmRequest(Object.assign({}, options, {
        headers: Object.assign({}, options.headers, {
          Authorization: `Bearer ${token}`
        })
      }));
    } catch (error) {
      if (allowRefresh === false || !(error && (error.status === 401 || error.status === 403))) {
        throw error;
      }
      this._token = null;
      return this._authorizedRequest(options, false);
    }
  }

  _fetchToken() {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (self._token) {
        console.log("Plus4U authentication token is ready.");
        resolve(self._token);
        return;
      }
      if (self._initializing) {
        console.log("Plus4U authentication token is already being fetched.");
        self._waitForToken(resolve, reject);
        return;
      }
      self._initializing = true;
      console.log(`Fetching Plus4U authentication token.`);
      const oidcDomain = "https://uuidentity.plus4u.net";
      const oidcUri = oidcDomain
          + "/uu-oidc-maing02/bb977a99f4cc4c37a2afce3fd599d0a7/oidc/auth?response_type=id_token%20token&redirect_uri=https%3A%2F%2Fuuapp.plus4u.net%2Fuu-contentwidgetsg02-uu5stringwidget%2F99923616732505139-9ba1fa2d23a14378aef39d651fb19b14%2Foidc%2Fcallback&client_id=9ba1fa2d23a14378aef39d651fb19b14&scope=openid%20https%3A%2F%2Fuuapp.plus4u.net%2Fuu-specialistwtmg01-main%2F99923616732453117-8031926f783d4aaba733af73c1974840&prompt=none";
      gmRequest({
        method: "GET",
        headers: {
          "Origin": oidcDomain,
          "Referer": oidcUri
        },
        url: oidcUri
      }).then(function (response) {
        const token = self._extractToken(response);
        self._initializing = false;
        if (!token) {
          reject(new Error("Plus4U authentication token is missing."));
          return;
        }
        self._token = token;
        resolve(token);
      }, function (error) {
        self._initializing = false;
        reject(error);
      });
    });
  }

  _waitForToken(resolve, reject) {
    const self = this;
    if (self._token) {
      resolve(self._token);
      return;
    }
    if (self._initializing) {
      setTimeout(function () {
        self._waitForToken(resolve, reject)
      }, 100);
      return;
    }
    reject(new Error("Plus4U authentication token is missing."));
  }

  _extractToken(response) {
    const finalUrl = response && response.finalUrl;
    if (!finalUrl) {
      return null;
    }
    const url = new URL(finalUrl.replace("#", "?"));
    const token = url.searchParams.get("id_token");
    if (token) {
      console.info("Plus4U authentication token obtained.");
    }
    return token;
  }

}

/**
 * JIRA API connector.
 *
 * https://docs.atlassian.com/software/jira/docs/api/REST/7.6.1/#api/2/
 */
class Jira4U {

  constructor() {
    this.jiraUrl = 'https://jira.unicorn.com';
    this.jiraRestApiUrl = this.jiraUrl + '/rest/api/2';
    this.jiraRestApiUrlIssue = this.jiraRestApiUrl + '/issue';
    this._worklogs = new Map();
  }

  /**
   * @param {string} key JIRA issue key string
   */
  async loadIssueWorklog(key) {
    if (this._worklogs.has(key)) {
      return this._worklogs.get(key);
    }
    const worklogs = await this._fetchIssueWorklog(key);
    this._worklogs.set(key, worklogs);
    return worklogs;
  }

  async _fetchIssueWorklog(key) {
    const worklogs = [];
    let startAt = 0;
    while (true) {
      const endpointUri = `${this.jiraRestApiUrlIssue}/${key}/worklog?startAt=${startAt}&maxResults=100`;
      console.info(`Loading issue ${key} from JIRA URL ${endpointUri}. `);
      const response = await gmRequest({
        method: "GET",
        headers: {"Accept": "application/json"},
        url: endpointUri
      });
      const dtoOut = JSON.parse(response.responseText);
      const page = Array.isArray(dtoOut.worklogs) ? dtoOut.worklogs : [];
      for (const entry of page) {
        worklogs.push(TimeEntry.fromJira(key, entry));
      }
      startAt += page.length;
      if (page.length === 0 || startAt >= dtoOut.total) {
        return worklogs;
      }
    }
  }

  async logWork(timeEntry) {
    if (!timeEntry.isJiraTask()) {
      console.info("Time entry not bound to JIRA issue.");
      return 0;
    }
    const startTime = timeEntry.start;
    const endTime = timeEntry.stop;
    let dtoIn = {};
    dtoIn.comment = timeEntry.workDescription.descriptionText;
    dtoIn.started = this.toIsoString(startTime);
    dtoIn.timeSpentSeconds = DateUtils.getDurationSec(startTime, endTime);
    let requestData = JSON.stringify(dtoIn);
    console.log(`Sending a work log request to ${timeEntry.workDescription.issueKey}. ${requestData}`);
    const response = await gmRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        //Disable the cross-site request check on the JIRA side
        "X-Atlassian-Token": "nocheck",
        //Previous header does not work for requests from a web browser
        "User-Agent": "xx"
      },
      data: requestData,
      url: this.jiraRestApiUrlIssue.concat("/", timeEntry.workDescription.issueKey, "/worklog")
    });
    this._worklogs.delete(timeEntry.workDescription.issueKey);
    return response;
  }

  /**
   * Converts a date to a proper ISO formatted string, which contains milliseconds and the zone offset suffix.
   * No other date formats are recognized by JIRA.
   * @param {Date} date Valid Date object to be formatted.
   * @returns {string}
   */
  toIsoString(date) {
    let offset = -date.getTimezoneOffset(),
        offsetSign = offset >= 0 ? '+' : '-',
        pad = function (num) {
          const norm = Math.floor(Math.abs(num));
          return (norm < 10 ? '0' : '') + norm;
        };
    return date.getFullYear()
        + '-' + pad(date.getMonth() + 1)
        + '-' + pad(date.getDate())
        + 'T' + pad(date.getHours())
        + ':' + pad(date.getMinutes())
        + ':' + pad(date.getSeconds())
        + '.' + String(date.getUTCMilliseconds()).padStart(3, "0").substr(0, 3)
        + offsetSign + pad(offset / 60) + pad(offset % 60);
  }

}

/**
 * Container for a JIRA issue key + description. It can construct itself by parsing the issue key from work description.
 */
class WorkDescription {

  constructor(issueKey = null, descriptionText = "") {
    this.issueKey = issueKey;
    this.descriptionText = descriptionText;
  }

  static parse(workDescriptionText) {
    let result = new WorkDescription();
    const jiraIssueKeyPattern = /^([A-Z]+-\d+)\b/;
    if (typeof workDescriptionText === "string") {
      let segments = workDescriptionText.match(jiraIssueKeyPattern);
      if (segments != null) {
        let key = segments[1];
        result = new WorkDescription(key, workDescriptionText.replace(key, "").trim());
      } else {
        result = new WorkDescription(null, workDescriptionText);
      }
    }
    return result;
  }

  toString() {
    return this.issueKey + " " + this.descriptionText;
  }
}

class Toggl {

  constructor() {
    this._me = undefined;
    this._initializing = false;
    this._url = "https://api.track.toggl.com";
    this._projects = new Map();
  }

  _fetchMe() {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (self._me) {
        console.log("Toggle user info is ready.");
        resolve(self._me);
        return;
      }
      if (self._initializing) {
        console.log("Toggle user info is already being fetched.");
        self._waitForResponse(resolve, reject);
        return;
      }
      self._initializing = true;
      console.log(`Fetching Toggl user info.`);
      gmRequest({
        method: "GET",
        headers: {"Accept": "application/json"},
        url: self._url.concat("/api/v9/me")
      }).then(function (response) {
        const me = JSON.parse(response.responseText);
        self._initializing = false;
        if (!me || !me.default_workspace_id) {
          reject(new Error("Toggl user info is incomplete."));
          return;
        }
        self._me = me;
        resolve(me);
      }, function (error) {
        self._initializing = false;
        reject(error);
      });
    });
  }

  _waitForResponse(resolve, reject) {
    const self = this;
    if (self._me) {
      resolve(self._me);
      return;
    }
    if (self._initializing) {
      setTimeout(function () {
        self._waitForResponse(resolve, reject)
      }, 100);
      return;
    }
    reject(new Error("Toggl user info is missing."));
  }

  loadTsr(interval) {
    return this._getTsr(interval).then(function (response) {
      const timeEntries = JSON.parse(response.responseText);
      if (!Array.isArray(timeEntries)) {
        throw new Error("Toggl time entries response is not a list.");
      }
      return timeEntries.map(entry => new TimeEntry(entry));
    });
  }

  async loadProject(timeEntry) {
    if (!timeEntry.pid) {
      return null;
    }
    if (this._projects.has(timeEntry.pid)) {
      return this._projects.get(timeEntry.pid);
    }
    const response = await this._getProject(timeEntry.pid);
    const project = JSON.parse(response.responseText);
    console.info(`Project with ID ${project.id} has name ${project.name}.`);
    this._projects.set(timeEntry.pid, project);
    return project;
  }

  _getTsr(interval) {
    console.info(`Fetching TSR from Toggl.`);
    return gmRequest({
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      },
      url: `${this._url}/api/v9/me/time_entries?start_date=${interval.start}&end_date=${interval.end}`
    });
  }

  async _getProject(projectId) {
    const me = await this._fetchMe();
    const projectUrl = `${this._url}/api/v9/workspaces/${me.default_workspace_id}/projects/${projectId}`;
    console.info(`Fetching project with ID ${projectId} from Toggl URL ${projectUrl}.`);
    return gmRequest({
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      },
      url: projectUrl
    });
  }

  roundTimeEntry(timeEntry) {
    if (!timeEntry.isFinished()) {
      return Promise.resolve();
    }
    const roundedStart = DateUtils.roundDate(timeEntry.start);
    const roundedStop = DateUtils.roundDate(timeEntry.stop);
    const roundedDuration = DateUtils.getDurationSec(roundedStart, roundedStop);
    if (!(roundedDuration > 0)) {
      console.warn("Zero duration during rounding. Won't do that! This is probably bug in the script.");
      return Promise.resolve();
    }
    return gmRequest({
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      data: JSON.stringify({
        start: roundedStart,
        stop: roundedStop,
        duration: roundedDuration
      }),
      url: `${this._url}/api/v9/time_entries/${timeEntry.id}`
    }).then(function () {
      timeEntry.roundedStart = roundedStart;
      timeEntry.roundedStop = roundedStop;
      timeEntry.roundedDuration = roundedDuration;
      timeEntry.applyRounding();
    });
  }

}

class DateUtils {

  static parseHtmlDate(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) {
      return null;
    }
    return {
      year: Number(match[1]),
      month: Number(match[2]) - 1,
      day: Number(match[3])
    };
  }

  static toStartDate(dateStr) {
    const parts = DateUtils.parseHtmlDate(dateStr);
    return parts ? new Date(parts.year, parts.month, parts.day, 0, 0, 0, 0) : new Date(NaN);
  }

  static toEndDate(dateStr) {
    const parts = DateUtils.parseHtmlDate(dateStr);
    return parts ? new Date(parts.year, parts.month, parts.day, 23, 59, 59, 0) : new Date(NaN);
  }

  static toHtmlFormat(date) {
    return date.getFullYear() + "-" + DateUtils.pad2(date.getMonth() + 1) + "-" + DateUtils.pad2(date.getDate());
  }

  static getDurationSec(start, end) {
    return (end - start) / 1000;
  }

  static pad2(number) {
    return (number < 10 ? '0' : '') + number;
  }

  static toDate(dateStr) {
    return dateStr ? new Date(dateStr) : undefined;
  }

  static roundDate(dateTime) {
    const roundedDate = new Date(dateTime.getTime());
    roundedDate.setMilliseconds(0);
    roundedDate.setSeconds(0);
    roundedDate.setMinutes(Math.round(dateTime.getMinutes() / 15) * 15);
    return roundedDate;
  }

  static getThisWeek() {
    let now = new Date();
    now.setMilliseconds(0);
    let first = now.getDate() - (now.getDay() + 6) % 7; // First day is the day of the month - the day of the week (monday made the first day)
    let last = first + 6; // last day is the first day + 6

    let firstDay = new Date(now);
    firstDay.setDate(first);
    firstDay.setSeconds(0);
    firstDay.setMinutes(0);
    firstDay.setHours(0);
    let lastDay = new Date(now);
    lastDay.setDate(last);
    lastDay.setSeconds(59);
    lastDay.setMinutes(59);
    lastDay.setHours(23);
    return {start: firstDay, end: lastDay};
  }

}

class ResponseCallback {

  constructor(onSuccess, onError, onOther) {
    this.onSuccess = onSuccess ? onSuccess : console.info;
    this.onError = onError ? onError : this.logBasicError;
    this.onOther = onOther ? onOther : console.info;
  }

  onResponse(response) {
    console.info(`Status of the received response: ${response.status}.`);
    if (response.status >= 400) {
      this.onError(response);
    } else if (response.status >= 300) {
      this.onOther(response);
    } else if (response.status >= 200) {
      this.onSuccess(response);
    } else {
      console.warn(`Cannot handle HTTP status ${response.status}. Response received: ${response}.`);
    }
  }

  logBasicError(response) {
    console.error(`Error response returned. Status code ${response.status}, message '${response.statusText}'. Response: ${response.responseText}.`)
  }

}

class TimeEntry {

  log = {
    plus4u: {
      result: false
    },
    jira: {
      result: false
    }
  }

  constructor(togglTimeEntry, togglProject) {
    if (togglTimeEntry) {
      this.id = togglTimeEntry.id;
      this.start = DateUtils.toDate(togglTimeEntry.start);
      this.stop = DateUtils.toDate(togglTimeEntry.stop);
      this.pid = togglTimeEntry.pid;
      this.duration = togglTimeEntry.duration;

      this.roundedStart = DateUtils.roundDate(this.start);
      if (this.isFinished()) {
        this.roundedStop = DateUtils.roundDate(this.stop);
        this.roundedDuration = DateUtils.getDurationSec(this.roundedStart, this.roundedStop);
      }

      if (togglTimeEntry.description) {
        this.description = togglTimeEntry.description.trim();
        this.workDescription = WorkDescription.parse(togglTimeEntry.description.trim());
      }
    }
    this.setTogglProject(togglProject);
    if (togglTimeEntry && togglTimeEntry.tags && togglTimeEntry.tags.length > 0) {
      this.category = togglTimeEntry.tags[0].trim();
    }
  }

  setTogglProject(togglProject) {
    this.project = togglProject ? togglProject.name.trim() : null;
  }

  isJiraTask() {
    return !!(this.workDescription && typeof this.workDescription.issueKey === "string");
  }

  markJiraCheckUnknown() {
    this.log.jira.unknown = true;
  }

  canReportToJira() {
    return this.isJiraTask() && !this.log.jira.unknown && this.isLoggedToPlus4u() && !this.isLoggedToJira();
  }

  sameTime(other) {
    return !!other
        && this.isFinished()
        && other.isFinished()
        && this.start.getTime() === other.start.getTime()
        && this.stop.getTime() === other.stop.getTime();
  }

  equalsPlus4u(other) {
    return this.sameTime(other);
  }

  equalsJira(other) {
    const issueKey = this.workDescription && this.workDescription.issueKey;
    const otherIssueKey = other && other.workDescription && other.workDescription.issueKey;
    return this.sameTime(other) && typeof issueKey === "string" && issueKey === otherIssueKey;
  }

  static fromPlus4u(entry) {
    //{"id":"6005411e3237d2000a6f94c1","datetimeFrom":"2021-01-14T10:00:00.000Z","datetimeTo":"2021-01-14T12:00:00.000Z","subject":"ues:UNI-BT:USYE.FBCORE/STAGE_4_EXT4","description":"Calls and development support","highRate":false,"data":{},"supplierContract":"default","workerUuIdentity":"2750-1","authorUuIdentity":"2750-1","subjectOU":"ues:UNI-BT[210795]:USYE.FBCORE[88101691420070400]:","timesheetOU":"ues:UNI-BT[210795]:USYE.FBCORE[88101691420070400]:","confirmerRole":"ues:UNI-BT[210795]:USYE.FBCORE~PM[73183517654488956]:","confirmerUuIdentity":"5-2664-1","timesheetBC":"ues:UNI-BT[210795]:USYE.FBCORE/PBC[146648486576140517]:","monthlyEvaluation":"5ff885533237d2000a666e7e","state":"active","awid":"8031926f783d4aaba733af73c1974840","sys":{"cts":"2021-01-18T08:04:46.533Z","mts":"2021-01-18T08:04:46.533Z","rev":0}}
    const instance = new TimeEntry();
    instance.start = DateUtils.toDate(entry.datetimeFrom);
    instance.stop = DateUtils.toDate(entry.datetimeTo);
    instance.roundedStart = instance.start;
    instance.roundedStop = instance.stop;
    instance.duration = DateUtils.getDurationSec(instance.start, instance.stop);
    instance.roundedDuration = instance.duration;
    instance.description = entry.description;
    instance.workDescription = WorkDescription.parse(entry.description);
    instance.project = typeof entry.subject === "string" ? entry.subject.replace(/^ues:/, "") : null;
    instance.category = entry.category;
    return instance;
  }

  static fromJira(issueKey, entry) {
    const instance = new TimeEntry();
    instance.start = DateUtils.toDate(entry.started);
    instance.stop = new Date(instance.start.getTime());
    instance.stop.setSeconds(instance.stop.getSeconds() + entry.timeSpentSeconds)
    instance.roundedStart = instance.start;
    instance.roundedStop = instance.stop;
    instance.duration = DateUtils.getDurationSec(instance.start, instance.stop);
    instance.roundedDuration = instance.duration;
    instance.workDescription = new WorkDescription(issueKey, entry.comment);
    instance.description = instance.workDescription.toString();
    return instance;
  }

  applyRounding() {
    this.start = this.roundedStart;
    this.stop = this.roundedStop;
    this.duration = this.roundedDuration;
  }

  setLoggedToPlus4u(err) {
    this.log.plus4u.result = err === null || err === undefined;
    this.log.plus4u.err = err;
  }

  isLoggedToPlus4u() {
    return this.log.plus4u.result;
  }

  setLoggedToJira(err) {
    this.log.jira.result = err === null || err === undefined;
    this.log.jira.err = err;
  }

  isLoggedToJira() {
    return this.log.jira.result;
  }

  isFinished() {
    return this.hasOwnProperty("stop") && this.stop !== null && this.stop !== undefined;
  }

  isRounded() {
    return this.isFinished()
        && this.start.getTime() === this.roundedStart.getTime()
        && this.stop.getTime() === this.roundedStop.getTime();
  }

  copyJiraTaskToCategory() {
    if (this.isJiraTask()) {
      this.category = this.workDescription.issueKey;
    }
  }

}

class ReportStatus {
  constructor() {
    this.totalEntries = 0;
    this.plus4uReported = 0;
    this.plus4uFailures = [];
    this.jiraRelated = 0;
    this.jiraReported = 0;
    this.jiraFailures = [];
  }

  reset(timeEntries) {
    this.plus4uFailures = [];
    this.plus4uReported = 0;
    this.jiraFailures = [];
    this.jiraReported = 0;
    this.jiraRelated = 0;
    this.totalEntries = Array.isArray(timeEntries) ? timeEntries.length : 0;
    if(Array.isArray(timeEntries)) {
      for (const entry of timeEntries) {
        if (entry.isJiraTask()) {
          this.jiraRelated++;
        }
        if (entry.isLoggedToJira()) {
          this.jiraReported++;
        }
        if (entry.isLoggedToPlus4u()) {
          this.plus4uReported++;
        }
      }
    }
    this.printProgress();
  }

  addPlus4u(failure) {
    if (failure) {
      this.plus4uFailures.push(failure);
    } else {
      this.plus4uReported++;
    }
    this.printProgress();
  }

  addJira(failure) {
    if (failure) {
      this.jiraFailures.push(failure);
    } else {
      this.jiraReported++;
    }
    this.printProgress();
  }

  printProgress() {
    setHtml("uniExtStatus", `
            <div><strong>Total entries: ${this.totalEntries}</strong>
            <br/><strong>Plus4U: </strong><span class=${this.plus4uReported === this.totalEntries ? "success" : ""}>${this.plus4uReported} already reported</span> out of ${this.totalEntries}. (<span class=${this.plus4uFailures.length
    > 0 ? "error" : ""}>${this.plus4uFailures.length} failed </span>)
            <br/><strong>Jira: </strong><span class=${this.jiraReported === this.jiraRelated ? "success"
        : ""}>${this.jiraReported} reported </span> out of ${this.jiraRelated} related. (<span class=${this.jiraFailures.length > 0 ? "error" : ""}>${this.jiraFailures.length} failed</span>).
        </div>`);
  }
}

class ScriptLog {

  constructor(textArea) {
    this.textArea = textArea;
  }

  info(message) {
    this.log("INFO", message);
  }

  error(message) {
    this.log("ERROR", message);
  }

  log(level, message) {
    this.textArea.value = `${new Date().toLocaleTimeString()} ${level}: ${message}\n${this.textArea.value}`;
  }

  clear() {
    this.textArea.value = "";
  }

}

class Storage {
  static AUTO_RND_ID = "uniAutoRnd";
  static CP_JIRA_KEY_ID = "uniCpJiraKey";

  static getBoolean(key, defautlValue = false) {
    return GM_getValue(key) ? GM_getValue(key) : defautlValue;
  }

  static save(key, value) {
    GM_setValue(key, value);
  }
}

class StoredValue {
  constructor(key) {
    this.value = Storage.getBoolean(key);
    this.key = key;
  }

  getValue() {
    return this.value;
  }

  save(ev) {
    this.value = ev.target.checked;
    Storage.save(this.key, this.value);
  }
}

(async function () {
  'use strict';

  const plus4uWtm = new Plus4uWtm();
  const toggl = new Toggl();
  const jira = new Jira4U();
  let appLog;
  let status = new ReportStatus();
  let autoRound = new StoredValue(Storage.AUTO_RND_ID);
  let cpJiraKey = new StoredValue(Storage.CP_JIRA_KEY_ID);
  console.log(`Automatic rounding: ${autoRound}`);
  let toolbarNodes = null;
  let toolbarInitialized = false;
  let syncingToolbar = false;
  let operationInProgress = false;
  const operationLock = createOperationLock();

  function setReportButtonsDisabled(disabled) {
    ["uniExtBtnRound", "uniExtBtnReport"].forEach(function (id) {
      const button = document.getElementById(id);
      if (button) {
        button.disabled = disabled;
      }
    });
  }

  async function runExclusive(action) {
    return operationLock.run(async function () {
      operationInProgress = true;
      setReportButtonsDisabled(true);
      try {
        await action();
      } finally {
        operationInProgress = false;
        setReportButtonsDisabled(false);
      }
    });
  }

  // Toggl first paints a centered spinner in `.content-wrapper`, then replaces that node
  // with the real shell once workspace data arrives. A one-shot inject into the spinner is discarded.
  let getShellWrapper = function () {
    const wrappers = document.querySelectorAll(".right-pane-inner .content-wrapper");
    for (const wrapper of wrappers) {
      const isLoadingShell = wrapper.classList.contains("items-center")
          && wrapper.classList.contains("justify-center");
      if (!isLoadingShell) {
        return wrapper;
      }
    }
    return null;
  };

  let ensureToolbarBuilt = function () {
    if (toolbarNodes) {
      return;
    }

    const thisWeek = DateUtils.getThisWeek();
    const configPanel = `<div class="inputPanel">
                  <div><label for="uniAutoRnd" style="display: inline-flex">Round time automatically: </label><input type="checkbox" ${autoRound.getValue() ? "checked" : ""} id="uniAutoRnd" style="display: inline-flex" />
                  <label for="uniCpJiraKey" style="display: inline-flex">Copy JIRA key as category: </label><input type="checkbox" ${cpJiraKey.getValue() ? "checked" : ""} id="uniCpJiraKey" style="display: inline-flex" /></div>
                </div>`;
    const inputPanel = `<div class="inputPanel">
                <div><label for="uniExtFrom">From:</label><input type="date" id="uniExtFrom" value=${DateUtils.toHtmlFormat(
        thisWeek.start)} /></div><div><label for="uniExtTo">To:</label><input type="date" id="uniExtTo" value=${DateUtils.toHtmlFormat(
        thisWeek.end)} /></div><div id="uniExtToSummary"></div><div id="uniExtStatus"></div><div id="uniExtLogs"><textarea id="uniExtAppLogArea" name="AppLog" rows="5" cols="100" disabled></textarea></div></div>`;
    const buttons = `<div class="buttonsPanel"><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button></div>`;
    const toolbar = `<div id="uniExtToolbar">${configPanel} <br/> ${inputPanel} ${buttons}</div><div id="uniExtMessages"></div>`;
    const template = document.createElement("template");
    template.innerHTML = toolbar;
    toolbarNodes = Array.from(template.content.childNodes).filter(function (node) {
      return node.nodeType === Node.ELEMENT_NODE;
    });

    const root = toolbarNodes[0];
    root.querySelector("#uniExtBtnRound").addEventListener("click", roundTsrReport, false);
    root.querySelector("#uniExtBtnReport").addEventListener("click", reportWork, false);
    root.querySelector("#uniExtFrom").addEventListener("change", onReportDataChange, false);
    root.querySelector("#uniExtTo").addEventListener("change", onReportDataChange, false);
    root.querySelector("#uniAutoRnd").addEventListener("click", autoRound.save.bind(autoRound), false);
    root.querySelector("#uniCpJiraKey").addEventListener("click", cpJiraKey.save.bind(cpJiraKey), false);
    appLog = new ScriptLog(root.querySelector("#uniExtAppLogArea"));
  };

  let syncToolbar = async function () {
    if (syncingToolbar) {
      return;
    }
    const wrapper = getShellWrapper();
    if (!wrapper) {
      return;
    }
    if (toolbarNodes && toolbarNodes[0].parentElement === wrapper) {
      return;
    }

    syncingToolbar = true;
    try {
      console.info("Adding toolbar to the page.");
      ensureToolbarBuilt();
      wrapper.prepend(...toolbarNodes);
      if (!toolbarInitialized) {
        toolbarInitialized = true;
        appLog.info("Toolbar initialized.");
        await printReportSummary();
      }
    } finally {
      syncingToolbar = false;
    }

    const currentWrapper = getShellWrapper();
    if (currentWrapper && toolbarNodes[0].parentElement !== currentWrapper) {
      await syncToolbar();
    }
  };

  let initPage = function () {
    console.info("Initializing Toggl2plus4u extension.");
    const observer = new MutationObserver(function () {
      syncToolbar();
    });
    observer.observe(document.body, {childList: true, subtree: true});
    syncToolbar();
  };

  let onReportDataChange = async function () {
    if (operationInProgress) {
      return;
    }
    await printReportSummary();
  }

  let printReportSummary = async function (timeEntries) {
    if (!Array.isArray(timeEntries)) {
      timeEntries = await loadAllReports();
    }
    status.reset(timeEntries);
    let sum = 0;
    let roundedSum = 0;
    let emptyItems = [];
    for (const te of timeEntries) {
      if (te.isFinished()) {
        sum += te.duration;
        if (te.roundedDuration === 0) {
          emptyItems.push(te);
        } else {
          roundedSum += te.roundedDuration;
        }
      }
    }
    let emptyItemsMsg = "";
    emptyItems.forEach(ei => emptyItemsMsg += `<div style="color: #ff0000"> Item ${escapeHtml(ei.description)} from day ${DateUtils.toHtmlFormat(ei.start)} has 0 duration after rounding!</div>`)
    setHtml("uniExtToSummary",
        `<div><div><strong>
            ${Math.round(sum / 60 / 60 * 100) / 100} </strong> hours 
            will be rounded to <strong>${Math.round(roundedSum / 60 / 60 * 100) / 100} </strong> hours.</div>
         <br />${emptyItemsMsg}
      </div>`);
    appLog.info(`Report summary has been updated.`);
  };

  let loadAllReports = async function () {
    // For reporting, we need only finished tasks
    try {
      appLog.info(`Loading time entries from Toggl.`);
      const timeEntries = (await toggl.loadTsr(getInterval())).filter(te => te.isFinished());
      appLog.info(`Loading existing time entries from Plus4u.`);
      const plus4uEntries = await plus4uWtm.loadTsr(getInterval());
      appLog.info(`Loaded ${timeEntries.length} entries from Toggl and ${plus4uEntries.length} from Plus4U.`);
      // Reporting one by one - // reporting is not handled correctly by Jira (https://community.atlassian.com/t5/Jira-Software-questions/Time-Tracking-quot-Logged-quot-shows-wrong-value/qaq-p/647203)
      for (const te of timeEntries) {
        try {
          te.setTogglProject(await toggl.loadProject(te));
        } catch (e) {
          const message = e && (e.responseText || e.message) || e;
          appLog.error(`Cannot load Toggl project: ${message}.`);
        }
        if (hasExactPlus4uMatch(te, plus4uEntries)) {
          te.setLoggedToPlus4u();
        }
        if (te.isJiraTask()) {
          try {
            const jiraTaskWorklogs = await jira.loadIssueWorklog(te.workDescription.issueKey);
            if (jiraTaskWorklogs.some(jirate => te.equalsJira(jirate))) {
              te.setLoggedToJira();
            }
          } catch (e) {
            te.markJiraCheckUnknown();
            const message = e && (e.responseText || e.message) || e;
            appLog.error(`Cannot load Jira worklog ${te.workDescription.issueKey}: ${message}.`);
          }
        }
      }
      return timeEntries;
    } catch (e) {
      const message = e && (e.responseText || e.message) || e;
      appLog.error(`Cannot load time reports: ${message}. Please see console for details.`);
      return [];
    }
  }

  let reportWork = async function () {
    await runExclusive(async function () {
      setHtml("uniExtMessages", "");
      const timeEntries = await loadAllReports();
      status.reset(timeEntries);
      appLog.info(`Reporting ${timeEntries.length} items.`);
      for (const timeEntry of timeEntries) {
        await reportItem(timeEntry);
      }
      appLog.info(`Reporting finished.`);
      await printReportSummary(timeEntries);
    });
  };

  async function reportItem(entry) {
    if (autoRound.getValue()) {
      console.info(`Auto rounding is enabled. Rounding item.`);
      try {
        await roundIfNeeded(entry);
      } catch (e) {
        const message = e && (e.responseText || e.message) || e;
        appLog.error(`Cannot round item: ${message}.`);
        return;
      }
      console.info(`Rounding of item finished.`);
    }
    if (cpJiraKey.getValue()) {
      entry.copyJiraTaskToCategory();
    }
    try {
      entry.setTogglProject(await toggl.loadProject(entry));
    } catch (e) {
      const message = e && (e.responseText || e.message) || e;
      appLog.error(`Cannot load Toggl project: ${message}.`);
      return;
    }
    if (!entry.isLoggedToPlus4u()) {
      try {
        await plus4uWtm.logWorkItem(entry);
        status.addPlus4u();
        entry.setLoggedToPlus4u();
      } catch (e) {
        if (isPlus4uOverlap(e)) {
          try {
            const existing = await plus4uWtm.loadTsr(getInterval());
            if (hasExactPlus4uMatch(entry, existing)) {
              status.addPlus4u();
              entry.setLoggedToPlus4u();
            } else {
              status.addPlus4u(e.responseText || e);
              appLog.error("Plus4U overlap does not match this time entry. Jira was not updated.");
            }
          } catch (reloadError) {
            const message = reloadError && (reloadError.responseText || reloadError.message) || reloadError;
            status.addPlus4u(message);
            appLog.error(`Cannot verify Plus4U overlap: ${message}.`);
          }
        } else if (e.responseText) {
          console.error(`Plus4U code: ${e.status}, response: ${e.responseText}`);
          status.addPlus4u(e.responseText);
          entry.setLoggedToPlus4u(e.responseText);
          appLog.error(`Cannot log to plus4u: ${e.responseText}.`);
        } else {
          console.error(`Plus4U error: ${e}`);
          status.addPlus4u(e);
          entry.setLoggedToPlus4u(e);
          appLog.error(`Cannot log to plus4u: ${e}.`);
        }
      }
    }

    if (entry.canReportToJira()) {
      try {
        await jira.logWork(entry);
        entry.setLoggedToJira();
        status.addJira();
      } catch (e) {
        if (e.responseText) {
          console.error(`Jira code: ${e.status}, response: ${e.responseText}`);
          status.addJira(e.responseText);
          appLog.error(`Cannot log to Jira: ${e.responseText}.`);
        } else {
          console.error(`Jira error: ${e}`);
          status.addJira(e);
          appLog.error(`Cannot log to Jira: ${e}.`);
        }
      }
    }
  }

  let roundTsrReport = async function (timeEntries) {
    await runExclusive(async function () {
      let interval = getInterval();
      if (!Array.isArray(timeEntries)) {
        console.warn(`Time entries not provided on input. Loading time entries. This may be suboptimal for performance.`);
        try {
          timeEntries = await toggl.loadTsr(interval);
        } catch (e) {
          const message = e && (e.responseText || e.message) || e;
          appLog.error(`Cannot load time entries: ${message}.`);
          return;
        }
      }
      for (const entry of timeEntries) {
        try {
          await roundIfNeeded(entry);
        } catch (e) {
          const message = e && (e.responseText || e.message) || e;
          appLog.error(`Cannot round item: ${message}.`);
        }
      }
      await printReportSummary();
    });
  };

  let roundIfNeeded = async function (timeEntry) {
    if (!timeEntry.isRounded()) {
      await toggl.roundTimeEntry(timeEntry);
    }
  }

  let getInterval = function () {
    let start = DateUtils.toStartDate(document.querySelector("#uniExtFrom").value).toISOString();
    let end = DateUtils.toEndDate(document.querySelector("#uniExtTo").value).toISOString();
    return {start, end};
  };

  await initPage();
})();

