// ==UserScript==
// @name         Toggl integration with Plus4U and Jira
// @namespace    https://github.com/jiri-neuman/toggl2plus4u
// @version      0.6.1
// @description  Integrates Toggl with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://toggl.com/app/timer*
// @match        https://*.toggl.com/timer*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      plus4u.net
// @connect      jira.unicorn.com
// @connect      toggl.com
// @require      http://code.jquery.com/jquery-2.1.4.min.js
// @require      https://code.jquery.com/ui/1.12.1/jquery-ui.js
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
      z-index: 1000;
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

class Plus4uWtm {

  constructor() {
    this._token = null;
    this._initializing = false;
    this._wtmUrl = "https://uuos9.plus4u.net/uu-specialistwtmg01-main/99923616732453117-8031926f783d4aaba733af73c1974840";
  }

  async logWorkItem(timeEntry) {
    const token = await this._fetchToken();
    const wtmUrl = this._wtmUrl;
    return await this._logWorkItem(timeEntry, token, wtmUrl);
  }

  _logWorkItem(timeEntry, token, wtmUrl) {
    return new Promise(function (resolve, reject) {
      let dtoIn = {};
      dtoIn.datetimeFrom = timeEntry.start.toISOString();
      dtoIn.datetimeTo = timeEntry.stop.toISOString();
      dtoIn.subject = `ues:${timeEntry.project.trim()}`;
      if (timeEntry.category) {
        dtoIn.category = timeEntry.category;
      }
      dtoIn.description = timeEntry.description;

      const requestData = JSON.stringify(dtoIn);
      console.info(`Sending time entry to Plus4U: ${requestData}`);

      let responseCallback = new ResponseCallback(resolve, reject);
      // noinspection JSUnresolvedFunction
      GM_xmlhttpRequest(
          {
            method: 'POST',
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
              "Origin": "https://uuos9.plus4u.net",
              "Referer": `${wtmUrl}`,
            },
            data: requestData,
            url: `${wtmUrl}/createTimesheetItem`,
            onload: responseCallback.onResponse.bind(responseCallback),
            onerror: reject
          },
      );

    });
  }

  async loadTsr(interval) {
    const token = await this._fetchToken();
    const wtmUrl = this._wtmUrl;
    const self = this;
    return new Promise(function (resolve, reject) {
      self._getTsr(interval, token, wtmUrl, function (e) {
        let dtoOut = JSON.parse(e.responseText);
        let loadTsrDtoOut = [];
        for (const entry of dtoOut.timesheetItemList) {
          loadTsrDtoOut.push(TimeEntry.fromPlus4u(entry));
        }
        resolve(loadTsrDtoOut);
      }, reject);
    });
  }

  _getTsr(interval, token, wtmUrl, responseCallback = new ResponseCallback()) {
    console.log(`Fetching time sheet reports from Plus4U WTM.`);
    const dtoIn = {
      datetimeFrom: interval.start,
      datetimeTo: interval.end
    }
    // noinspection JSUnresolvedFunction
    GM_xmlhttpRequest(
        {
          method: 'POST',
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "Origin": "https://uuos9.plus4u.net",
            "Referer": `${wtmUrl}`
          },
          data: JSON.stringify(dtoIn),
          url: `${wtmUrl}/listWorkerTimesheetItemsByTime`,
          onload: responseCallback,
          onerror: console.error
        }
    );
  }

  _fetchToken() {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (self._token) {
        console.log("Plus4U authentication token is ready.");
        resolve(self._token);
      }
      if (self._initializing) {
        console.log("Plus4U authentication token is already being fetched.");
        self._waitForToken(resolve, reject);
      } else {
        self._initializing = true;
        console.log(`Fetching Plus4U authentication token.`);
        // noinspection JSUnresolvedFunction
        const oidcDomain = "https://uuidentity.plus4u.net";
        const oidcUri = oidcDomain
            + "/uu-oidc-maing02/bb977a99f4cc4c37a2afce3fd599d0a7/oidc/auth?response_type=id_token%20token&redirect_uri=https%3A%2F%2Fuuos9.plus4u.net%2Fuu-contentwidgetsg02-uu5stringwidget%2F99923616732505139-9ba1fa2d23a14378aef39d651fb19b14%2Foidc%2Fcallback&client_id=9ba1fa2d23a14378aef39d651fb19b14&scope=openid%20https%3A%2F%2Fuuos9.plus4u.net%2Fuu-specialistwtmg01-main%2F99923616732453117-8031926f783d4aaba733af73c1974840&prompt=none";
        GM_xmlhttpRequest(
            {
              method: 'GET',
              headers: {
                "Origin": oidcDomain,
                "Referer": oidcUri
              },
              url: oidcUri,
              onload: function (e) {
                self._extractToken(e);
                self._initializing = false;
                resolve(self._token);
              },
              onerror: function (e) {
                self._initializing = false;
                reject(e);
              }
            }
        );
      }
    });
  }

  _waitForToken(resolve, reject) {
    const self = this;
    if (self._token) {
      resolve(self._token);
    }
    if (self._initializing) {
      setTimeout(function () {
        self._waitForToken(resolve, reject)
      }, 100);
    } else {
      reject();
    }

  }

  _extractToken(e) {
    let url = new URL(e.finalUrl.replace("#", "?"));
    this._token = url.searchParams.get("id_token");
    console.info("Plus4U authentication token obtained.");
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
  }

  /**
   * @param {string} key JIRA issue key string
   */
  async loadIssueWorklog(key) {
    const self = this;
    return new Promise(function (resolve, reject) {
      let endpointUri = self.jiraRestApiUrlIssue.concat("/", key).concat("/worklog");
      console.info(`Loading issue ${key} from JIRA URL ${endpointUri}. `);
      let responseCallback = new ResponseCallback(function (e) {
        let dtoOut = JSON.parse(e.responseText);
        let loadTsrDtoOut = [];
        for (const entry of dtoOut.worklogs) {
          loadTsrDtoOut.push(TimeEntry.fromJira(key, entry));
        }
        resolve(loadTsrDtoOut);
      }, reject);
      // noinspection JSUnresolvedFunction
      GM_xmlhttpRequest(
          {
            method: 'GET',
            headers: {"Accept": "application/json"},
            url: endpointUri,
            onreadystatechange: onprogress || function (res) {
              console.log("Request state: " + res.readyState);
            },
            onload: responseCallback.onResponse.bind(responseCallback),
            onerror: onerror
          }
      );
    });
  }

  async logWork(timeEntry) {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (!timeEntry.isJiraTask()) {
        console.info("Time entry not bound to JIRA issue.");
        resolve(0);
      }
      const startTime = timeEntry.start;
      const endTime = timeEntry.stop;
      let dtoIn = {};
      dtoIn.comment = timeEntry.workDescription.descriptionText;
      dtoIn.started = self.toIsoString(startTime);
      dtoIn.timeSpentSeconds = DateUtils.getDurationSec(startTime, endTime);
      let requestData = JSON.stringify(dtoIn);
      console.log(`Sending a work log request to ${timeEntry.workDescription.issueKey}. ${requestData}`);
      let responseCallback = new ResponseCallback(resolve, reject);
      // noinspection JSUnresolvedFunction
      GM_xmlhttpRequest(
          {
            method: 'POST',
            headers: {
              "Content-Type": "application/json",
              //Disable the cross-site request check on the JIRA side
              "X-Atlassian-Token": "nocheck",
              //Previous header does not work for requests from a web browser
              "User-Agent": "xx"
            },
            data: requestData,
            url: self.jiraRestApiUrlIssue.concat("/", timeEntry.workDescription.issueKey, "/worklog"),
            onload: responseCallback.onResponse.bind(responseCallback),
            onerror: reject
          }
      );
    });
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
    const jiraIssueKeyPattern = /([A-Z]+-\d+)/;
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

  constructor(apiKey) {
    const storageKey = Object.keys(window.sessionStorage).find(k => k.match("api/.*/me"));
    console.info(`Loading apiKey from session storage ${storageKey}.`);
    if (apiKey === null || apiKey === undefined) {
      apiKey = JSON.parse(window.sessionStorage.getItem(storageKey)).api_token;
      console.info(`ApiKey loaded: "${apiKey}".`);
    }
    this._apiKey = btoa(apiKey + ":api_token");
  }

  loadTsr(interval) {
    const self = this;
    return new Promise(function (resolve, reject) {
      self._getTsr(interval, function (e) {
        let timeEntries = JSON.parse(e.responseText);
        let loadTsrDtoOut = [];
        for (const entry of timeEntries) {
          loadTsrDtoOut.push(new TimeEntry(entry));
        }
        resolve(loadTsrDtoOut);
      }, reject);
    });
  }

  async loadProject(timeEntry) {
    const self = this;
    return new Promise(function (resolve) {
      if (timeEntry.pid) {
        self._getProject(timeEntry.pid, function (resp) {
          let project = JSON.parse(resp.responseText).data;
          console.info(`Project with ID ${project.id} has name ${project.name}.`);
          resolve(project);
        });
      } else {
        resolve(null);
      }
    });
  }

  _getTsr(interval, onSuccess, onError = console.error) {
    const self = this;
    let _onSuccess = (typeof onSuccess === 'undefined') ? console.info : onSuccess;
    console.info(`Fetching TSR from Toggl.`);

    // noinspection JSUnresolvedFunction
    GM_xmlhttpRequest(
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${self._apiKey}`
          },
          url: `https://www.toggl.com/api/v8/time_entries?start_date=${interval.start}&end_date=${interval.end}`,
          onload: Toggl._getRetryingFunction(_onSuccess, self._getTsr, [interval, onSuccess]),
          onerror: onError
        },
    );
  }

  _getProject(projectId, onSuccess) {
    let _onSuccess = (typeof onSuccess === 'undefined') ? console.info : onSuccess;
    console.info(`Fetching project with ID ${projectId} from Toggl.`);
    // noinspection JSUnresolvedFunction
    GM_xmlhttpRequest(
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${this._apiKey}`
          },
          url: `https://www.toggl.com/api/v8/projects/${projectId}`,
          onload: Toggl._getRetryingFunction(_onSuccess, this._getProject.bind(this), [projectId, onSuccess]),
          onerror: console.error
        },
    );
  }

  roundTimeEntry(timeEntry) {
    const self = this;
    timeEntry.applyRounding();
    return new Promise(function (resolve, reject) {
      let dtoIn = {};
      dtoIn.time_entry = {};
      dtoIn.time_entry.start = timeEntry.roundedStart;
      dtoIn.time_entry.stop = timeEntry.roundedStop;
      dtoIn.time_entry.duration = timeEntry.roundedDuration;
      if (dtoIn.time_entry.duration === 0 || isNaN(dtoIn.time_entry.duration)) {
        console.warn("Zero duration during rounding. Won't do that! This is probably bug in the script.");
        return;
      }
      const requestData = JSON.stringify(dtoIn);
      // noinspection JSUnresolvedFunction
      GM_xmlhttpRequest(
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Basic ${self._apiKey}`
            },
            data: requestData,
            url: `https://www.toggl.com/api/v8/time_entries/${timeEntry.id}`,
            onload: Toggl._getRetryingFunction(resolve, self.roundTimeEntry.bind(self), [timeEntry]),
            onerror: reject
          }
      );
    })
  }

  static _getRetryingFunction(originalHandler, calledFunction, params) {
    return function (response) {
      if (response.status === 429) {
        console.info(`Too many requests when calling ${calledFunction} with params ${params}. Will retry in a moment.`);
        let timeout = 500 + Math.floor(Math.random() * 1000);
        setTimeout(calledFunction, timeout, ...params);
      } else {
        originalHandler(response);
      }
    };
  }

}

class DateUtils {

  static toStartDate(dateStr) {
    return new Date(dateStr);
  }

  static toEndDate(dateStr) {
    let date = new Date(dateStr);
    date.setHours(23);
    date.setMinutes(59);
    date.setSeconds(59);
    date.setMilliseconds(0);
    return date;
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
    return typeof this.workDescription.issueKey === 'string';
  }

  equals(other) {
    // Intended to compare items from different sources (jira, toggl, plus4u) so must contain only common fields
    return this.start.getTime() === other.start.getTime()
        && this.stop.getTime() === other.stop.getTime()
        && this.description === other.description;
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
    instance.project = entry.subject.replace("ues:", "");
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
    this.totalEntries = timeEntries.length;
    this.plus4uFailures = [];
    this.plus4uReported = 0;
    this.jiraFailures = [];
    this.jiraReported = 0;
    this.jiraRelated = 0;
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
    $("#uniExtStatus").html(`
            <div><strong>Total entries: ${this.totalEntries}</strong>
            <br/><strong>Plus4U: </strong><span class=${this.plus4uReported === this.totalEntries ? "success" : ""}>${this.plus4uReported} reported </span> (<span class=${this.plus4uFailures.length
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

(async function () {
  'use strict';

  const AUTO_RND_ID = "uniAutoRnd";

  const plus4uWtm = new Plus4uWtm();
  const toggl = new Toggl();
  const jira = new Jira4U();
  let appLog;
  let status = new ReportStatus();
  let autoRound = GM_getValue(AUTO_RND_ID) ? GM_getValue(AUTO_RND_ID) : false;
  console.log(`Automatic rounding: ${autoRound}`);
  let initPage = async function () {
    console.info("Initializing Toggl2plus4u extension.");

    if (!isPageReady()) {
      setTimeout(initPage, 1000);
      return;
    }

    await addToolbar();
  };

  let isPageReady = function () {
    return $(".right-pane-inner").length;
  };

  let saveAutoRoundingCfg = function (ev) {
    const newValue = ev.target.checked;
    GM_setValue(AUTO_RND_ID, newValue);
  };

  let addToolbar = async function () {
    console.info("Adding toolbar to the page.");

    const thisWeek = DateUtils.getThisWeek();
    const configPanel = `<div class="inputPanel">
                  <div><label for="uniAutoRnd" style="display: inline-flex">Round time automatically: </label><input type="checkbox" ${autoRound ? "checked" : ""} id="uniAutoRnd" style="display: inline-flex" /></div>
                </div>`;
    const inputPanel = `<div class="inputPanel">
                <div><label for="uniExtFrom">From:</label><input type="date" id="uniExtFrom" value=${DateUtils.toHtmlFormat(
        thisWeek.start)} /></div><div><label for="uniExtTo">To:</label><input type="date" id="uniExtTo" value=${DateUtils.toHtmlFormat(
        thisWeek.end)} /></div><div id="uniExtToSummary"></div><div id="uniExtStatus"></div><div id="uniExtLogs"><textarea id="uniExtAppLogArea" name="AppLog" rows="5" cols="100" disabled></textarea></div></div>`;
    const buttons = `<div class="buttonsPanel"><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button></div>`;
    const toolbar = `<div id="uniExtToolbar">${configPanel} <br/> ${inputPanel} ${buttons}</div><div id="uniExtMessages"></div>`;
    $(".right-pane-inner .content-wrapper").append(toolbar);

    document.getElementById("uniExtBtnRound").addEventListener("click", roundTsrReport, false);
    document.getElementById("uniExtBtnReport").addEventListener("click", reportWork, false);
    document.getElementById("uniExtFrom").addEventListener("change", onReportDataChange, false);
    document.getElementById("uniExtTo").addEventListener("change", onReportDataChange, false);
    document.getElementById("uniAutoRnd").addEventListener("click", saveAutoRoundingCfg, false);

    appLog = new ScriptLog(document.getElementById("uniExtAppLogArea"));
    appLog.info("Toolbar initialized.");
    await printReportSummary();
  };

  let onReportDataChange = async function() {
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
    emptyItems.forEach(ei => emptyItemsMsg += `<div style="color: #ff0000"> Item ${ei.description} from day ${DateUtils.toHtmlFormat(ei.start)} has 0 duration after rounding!</div>`)
    $("#uniExtToSummary").html(
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
        if (plus4uEntries.some(uute => uute.equals(te))) {
          te.setLoggedToPlus4u();
        }
        if (te.isJiraTask()) {
          const jiraTaskWorklogs = await jira.loadIssueWorklog(te.workDescription.issueKey);
          if (jiraTaskWorklogs.some(jirate => jirate.equals(te))) {
            te.setLoggedToJira();
          }
        }
      }
      return timeEntries;
    } catch (e) {
      appLog.error(`Cannot load time reports: ${e.message}. Please see console for details.`);
    }
  }

  let reportWork = async function () {
    $("#uniExtMessages").html("");
    const timeEntries = await loadAllReports();
    status.reset(timeEntries);
    appLog.info(`Reporting ${timeEntries.length} items.`);
    for (const timeEntry of timeEntries) {
      await reportItem(timeEntry);
    }
    appLog.info(`Reporting finished.`);
    await printReportSummary(timeEntries);
  };

  async function reportItem(entry) {
    if (autoRound) {
      console.info(`Auto rounding is enabled. Rounding item.`);
      await roundIfNeeded(entry);
      console.info(`Rounding of item finished.`);
    }
    entry.setTogglProject(await toggl.loadProject(entry));
    if (!entry.isLoggedToPlus4u()) {
      try {
        await plus4uWtm.logWorkItem(entry);
        status.addPlus4u();
        entry.setLoggedToPlus4u();
      } catch (e) {
        if (e.responseText) {
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

    if (entry.isJiraTask() && !entry.isLoggedToJira()) {
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
    let interval = getInterval();
    if (!Array.isArray(timeEntries)) {
      console.warn(`Time entries not provided on input. Loading time entries. This may be suboptimal for performance.`);
      timeEntries = await toggl.loadTsr(interval);
    }
    for (const entry of timeEntries) {
      await roundIfNeeded(entry);
    }
    await printReportSummary();
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

