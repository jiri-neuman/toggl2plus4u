// ==UserScript==
// @name         Toggl integration with Plus4U and Jira
// @namespace    https://github.com/jiri-neuman/toggl2plus4u
// @version      0.5.3
// @description  Integrates Toggl with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://toggl.com/app/timer*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      plus4u.net
// @connect      jira.unicorn.eu
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
      margin: 0 5px;
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
      dtoIn.datetimeFrom = new Date(timeEntry.start).toISOString();
      dtoIn.datetimeTo = new Date(timeEntry.stop).toISOString();
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

  getTsr(responseCallback = new ResponseCallback()) {
    console.log(`Fetching time sheet reports from Plus4U WTM.`);
    //TODO dateTime as argument

    // noinspection JSUnresolvedFunction
    GM_xmlhttpRequest(
        {
          method: 'POST',
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._token}`,
            "Origin": "https://uuos9.plus4u.net",
            "Referer": `${this._wtmUrl}`
          },
          data: `{"yearMonth":"201812"}`,
          url: `${this._wtmUrl}/listWorkerTimesheetItemsByMonth`,
          onload: responseCallback.onResponse.bind(responseCallback),
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
        GM_xmlhttpRequest(
            {
              method: 'GET',
              headers: {
                "Origin": "https://oidc.plus4u.net",
                "Referer": "https://oidc.plus4u.net/uu-oidcg01-main/99923616732452117-4f06dafc03cb4c7f8c155aa53f0e86be/oauth2?scope=openid&response_type=id_token&prompt=none&redirect_uri=https%3A%2F%2Fplus4u.net%2Fues%2Foauth-login-callback"
              },
              url: "https://oidc.plus4u.net/uu-oidcg01-main/99923616732452117-4f06dafc03cb4c7f8c155aa53f0e86be/oauth2?scope=openid&response_type=id_token&prompt=none&redirect_uri=https%3A%2F%2Fplus4u.net%2Fues%2Foauth-login-callback",
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
 */
class Jira4U {

  constructor() {
    this.jiraUrl = 'https://jira.unicorn.eu';
    this.jiraBrowseIssue = this.jiraUrl + "/browse";
    this.jiraRestApiUrl = this.jiraUrl + '/rest/api/2';
    this.jiraRestApiUrlIssue = this.jiraRestApiUrl + '/issue';
    this.jiraIssueKeyPattern = /([A-Z]+-\d+)/;
  }

  /**
   * @param {string} key JIRA issue key string
   * @param {ResponseCallback} responseCallback
   * @param {Function} onerror
   * @param {?Function} onprogress Optional loading progress callback
   */
  loadIssue(key, responseCallback, onerror, onprogress) {
    console.info(`Loading issue ${key} from JIRA URL ${this.jiraRestApiUrlIssue.concat("/", key)}. `);
    // noinspection JSUnresolvedFunction
    GM_xmlhttpRequest(
        {
          method: 'GET',
          headers: {"Accept": "application/json"},
          url: this.jiraRestApiUrlIssue.concat("/", key),
          onreadystatechange: onprogress || function (res) {
            console.log("Request state: " + res.readyState);
          },
          onload: responseCallback.onResponse.bind(responseCallback),
          onerror: onerror
        }
    );
  }

  async logWork(timeEntry) {
    const self = this;
    return new Promise(function (resolve, reject) {
      if (!timeEntry.isJiraTask()) {
        console.info("Time entry not bound to JIRA issue.");
        resolve(0);
      }
      const startTime = new Date(timeEntry.start);
      const endTime = new Date(timeEntry.stop);
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
    const jiraIssueKeyPattern = /([A-Z]+-\d+)/;
    if (typeof workDescriptionText === "string") {
      let segments = workDescriptionText.match(jiraIssueKeyPattern);
      if (segments != null) {
        let key = segments[1];
        return new WorkDescription(key, workDescriptionText.replace(key, "").trim());
      }
    }
    return new WorkDescription();
  }
}

class Toggl {

  constructor(apiKey) {
    if (apiKey === null || apiKey === undefined) {
      apiKey = "";
    }
    this._apiKey = apiKey;
  }

  loadTsr(interval) {
    const self = this;
    return new Promise(function (resolve, reject) {
      self._getTsr(interval, function (e) {
        console.log(e);
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
    return new Promise(function (resolve, reject) {
      if (timeEntry.pid) {
        self._getProject(timeEntry.pid, function (resp) {
          let project = JSON.parse(resp.responseText).data;
          console.info(`Project with ID ${project.id} has name ${project.name}.`);
          let timeEntryObj = new TimeEntry(timeEntry, project);
          resolve(timeEntryObj);
        });
      } else {
        let timeEntryObj = new TimeEntry(timeEntry);
        resolve(timeEntryObj);
      }
    });
  };

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
  };

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
  };

  roundTimeEntry(timeEntry) {
    const self = this;
    return new Promise(function (resolve, reject) {
      let start = new Date(timeEntry.start);
      let end = new Date(timeEntry.stop);
      DateUtils.roundDate(start);
      DateUtils.roundDate(end);

      let dtoIn = {};
      dtoIn.time_entry = {};
      dtoIn.time_entry.start = start;
      dtoIn.time_entry.stop = end;
      dtoIn.time_entry.duration = DateUtils.getDurationSec(start, end);
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
  };

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
  };

  static toEndDate(dateStr) {
    let date = new Date(dateStr);
    date.setHours(23);
    date.setMinutes(59);
    date.setSeconds(59);
    date.setMilliseconds(0);
    return date;
  };

  static toHtmlFormat(date) {
    return date.getFullYear() + "-" + DateUtils.pad2(date.getMonth() + 1) + "-" + DateUtils.pad2(date.getDate());
  };

  static getDurationSec(start, end) {
    return (end - start) / 1000;
  }

  static pad2(number) {
    return (number < 10 ? '0' : '') + number;
  }

  static roundDate(dateTime) {
    dateTime.setMilliseconds(0);
    dateTime.setSeconds(0);
    dateTime.setMinutes(Math.round(dateTime.getMinutes() / 15) * 15);
  };

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

  constructor(togglTimeEntry, togglProject) {
    this.id = togglTimeEntry.id;
    this.start = togglTimeEntry.start;
    this.stop = togglTimeEntry.stop;
    this.pid = togglTimeEntry.pid;
    this.duration = togglTimeEntry.duration;
    if (togglTimeEntry.description) {
      this.description = togglTimeEntry.description.trim();
      this.workDescription = WorkDescription.parse(togglTimeEntry.description.trim());
    }
    if (togglProject) {
      this.project = togglProject.name.trim();
    }
    if (togglTimeEntry.tags && togglTimeEntry.tags.length > 0) {
      this.category = togglTimeEntry.tags[0].trim();
    }
  }

  isJiraTask() {
    return this.workDescription.issueKey;
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
  };
}

(async function () {
  'use strict';

  const plus4uWtm = new Plus4uWtm();
  let toggl = new Toggl(GM_getValue("uniTogglApiKey"));
  const jira = new Jira4U();
  let status = new ReportStatus();

  let initPage = async function () {
    console.info("Initializing Toggl2plus4u extension.");

    if (!isPageReady()) {
      setTimeout(initPage, 1000);
      return;
    }

    await addToolbar();
  };

  let isPageReady = function () {
    let page = $(".right-pane-inner");
    return page.length;
  };

  let addToolbar = async function () {
    console.info("Adding toolbar to the page.");

    const thisWeek = DateUtils.getThisWeek();
    const configPanel = `<div class="inputPanel">
                <div><label for="uniTogglApiKey">Toggle BASIC auth value:</label><input type="password" value="${toggl._apiKey}" id="uniTogglApiKey" placeholder="Enter your BASIC auth value" /></div>
                <div class="buttonsPanel"><button id="uniExtBtnConfigSave">Save</button></div>
                </div>`;
    const inputPanel = `<div class="inputPanel">
                <div><label for="uniExtFrom">From:</label><input type="date" id="uniExtFrom" value=${DateUtils.toHtmlFormat(
        thisWeek.start)} /></div><div><label for="uniExtTo">To:</label><input type="date" id="uniExtTo" value=${DateUtils.toHtmlFormat(
        thisWeek.end)} /></div><div id="uniExtToSummary"></div><div id="uniExtStatus"></div></div>`;
    const buttons = `<div class="buttonsPanel"><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button></div>`;
    const toolbar = `<div id="uniExtToolbar">${configPanel} <br/> ${inputPanel} ${buttons}</div>`;
    $(".right-pane-inner .content-wrapper").append(toolbar);

    document.getElementById("uniExtBtnRound").addEventListener("click", roundTsrReport, false);
    document.getElementById("uniExtBtnReport").addEventListener("click", reportWork, false);
    document.getElementById("uniExtFrom").addEventListener("change", printReportSummary, false);
    document.getElementById("uniExtTo").addEventListener("change", printReportSummary, false);
    document.getElementById("uniTogglApiKey").addEventListener("change", applyConfig, false);
    document.getElementById("uniExtBtnConfigSave").addEventListener("click", saveConfig, false);

    console.info("Toolbar init finished");
    await printReportSummary();
  };

  let printReportSummary = async function () {
    const timeEntries = await toggl.loadTsr(getInterval());
    status.reset(timeEntries);
    let sum = 0;
    let roundedSum = 0;
    for (const te of timeEntries) {
      if (te.duration > 0) {
        sum += te.duration;
        let start = new Date(te.start);
        let end = new Date(te.stop);
        DateUtils.roundDate(start);
        DateUtils.roundDate(end);
        roundedSum += DateUtils.getDurationSec(start, end);
      }
    }
    $("#uniExtToSummary").html(
        `<div><strong>${Math.round(sum / 60 / 60 * 100) / 100} </strong> hours will be rounded to <strong>${Math.round(roundedSum / 60 / 60 * 100) / 100} </strong> hours</div>`);
  };

  let applyConfig = async function () {
    let apiKey = document.querySelector("#uniTogglApiKey").value;
    toggl = new Toggl(apiKey);
    await printReportSummary();
  };

  let saveConfig = async function () {
    let apiKey = document.querySelector("#uniTogglApiKey").value;
    if (apiKey === "") {
      GM_deleteValue("uniTogglApiKey");
    } else {
      GM_setValue("uniTogglApiKey", apiKey);
    }
  };

  let reportWork = async function () {
    let interval = getInterval();
    let timeEntries = await toggl.loadTsr(interval);
    status.reset(timeEntries);
    timeEntries.forEach(async function (entry) {
      let timeEntry = await toggl.loadProject(entry);
      try {
        await plus4uWtm.logWorkItem(timeEntry);
      } catch (e) {
        if (e.responseText) {
          const dtoOut = JSON.parse(e.responseText);
          if (dtoOut.uuAppErrorMap["uu-specialistwtm-main/createTimesheetItem/overlappingItemExists"] !== undefined) {
            // If the item overlaps an existing one, consider it already reported and set as success. Also if it is related to Jira, consider it reported too.
            // TODO this might be improved to check duration and description and also to check if it is reported in Jira or not
            console.warn(`Entry already exists in Plus4U. ${e.responseText}`);
            status.addPlus4u();
            if (timeEntry.isJiraTask()) {
              status.addJira();
            }
          } else {
            console.error(`Plus4U code: ${e.status}, response: ${e.responseText}`);
            status.addPlus4u(e.responseText);
          }
        } else {
          console.error(`Plus4U error: ${e}`);
          status.addPlus4u(e);
        }
        return;
      }
      status.addPlus4u();
      if (timeEntry.isJiraTask()) {
        try {
          await jira.logWork(timeEntry);
        } catch (e) {
          if (e.responseText) {
            console.error(`Jira code: ${e.status}, response: ${e.responseText}`);
            status.addJira(e.responseText);
          } else {
            console.error(`Jira error: ${e}`);
            status.addJira(e);
          }
          return;
        }
        status.addJira();
      }
    });
  };

  let roundTsrReport = async function () {
    let interval = getInterval();
    let timeEntries = await toggl.loadTsr(interval);
    for (const entry of timeEntries) {
      await toggl.roundTimeEntry(entry);
    }
    await printReportSummary();
  };

  let getInterval = function () {
    let start = DateUtils.toStartDate(document.querySelector("#uniExtFrom").value).toISOString();
    let end = DateUtils.toEndDate(document.querySelector("#uniExtTo").value).toISOString();
    return {start, end};
  };

  await initPage();
})();

