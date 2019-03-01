// ==UserScript==
// @name         Toggl integration with Plus4U and Jira
// @namespace    https://github.com/jiri-neuman/toggl2plus4u
// @version      0.3
// @description  Integrates Toggl with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://toggl.com/app/timer
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
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
`);

class Plus4uWtm {

    constructor() {
        this._token = null;
        this._initializing = false;
        this._wtmUrl = "https://uuos9.plus4u.net/uu-specialistwtmg01-main/99923616732453117-8031926f783d4aaba733af73c1974840";
    }

    logWorkItem(timeEntry, responseCallback = new ResponseCallback()) {
        const self = this;
        this._fetchToken().then(function (token) {
            self._logWorkItem(timeEntry, responseCallback, token, self._wtmUrl);
        }, function (err) {
            console.error(err);
        })

    }

    _logWorkItem(timeEntry, responseCallback, token, wtmUrl) {
        let dtoIn = {};
        dtoIn.datetimeFrom = new Date(timeEntry.start).toISOString();
        dtoIn.datetimeTo = new Date(timeEntry.end).toISOString();
        dtoIn.subject = `ues:${timeEntry.project.trim()}`;
        if (timeEntry.category) {
            dtoIn.category = timeEntry.category;
        }
        dtoIn.description = timeEntry.description;

        const requestData = JSON.stringify(dtoIn);
        console.debug(`Sending time entry to Plus4U: ${requestData}`);

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
                onerror: console.error
            },
        );
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
        if(self._token) {
            resolve(self._token);
        }
        if(self._initializing) {
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
    loadIssue(key, responseCallback = new ResponseCallback(), onerror, onprogress) {
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

    logWork(timeEntry, responseCallback = new ResponseCallback(), onerror = console.error, onprogress) {
        let workDescription = WorkDescription.parse(timeEntry.description);
        console.info(timeEntry, workDescription);
        if (!workDescription.issueKey) {
            console.info("Time entry not bound to JIRA issue.");
            return;
        }
        const startTime = new Date(timeEntry.start);
        const endTime = new Date(timeEntry.end);
        let dtoIn = {};
        dtoIn.comment = workDescription.descriptionText;
        dtoIn.started = this.toIsoString(startTime);
        dtoIn.timeSpentSeconds = DateUtils.getDurationSec(startTime, endTime);
        let requestData = JSON.stringify(dtoIn);
        console.log(`Sending a work log request to ${workDescription.issueKey}. ${requestData}`);
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
                url: this.jiraRestApiUrlIssue.concat("/", workDescription.issueKey, "/worklog"),
                onreadystatechange: onprogress,
                onload: responseCallback.onResponse.bind(responseCallback),
                onerror: onerror
            }
        );
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

    constructor() {
    }

    loadTsr(interval, onSuccess) {
        const self = this;
        let loadProject = function (timeEntry) {
            if (timeEntry.pid) {
                self.getProject(timeEntry.pid, function (resp) {
                    let project = JSON.parse(resp.responseText).data;
                    console.info(`Project with ID ${project.id} has name ${project.name}.`)
                    let timeEntryObj = new TimeEntry(timeEntry, project);
                    onSuccess(timeEntryObj);
                });
            } else {
                let timeEntryObj = new TimeEntry(timeEntry);
                onSuccess(timeEntryObj);
            }
        };
        self.getTsr(interval, function (e) {
            let timeEntries = JSON.parse(e.responseText);
            timeEntries.forEach(loadProject.bind(self));
        });
    }

    getTsr(interval, onSuccess) {
        const self = this;
        let _onSuccess = (typeof onSuccess === 'undefined') ? console.info : onSuccess;
        console.info(`Fetching TSR from Toggl.`);

        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                },
                url: `https://www.toggl.com/api/v8/time_entries?start_date=${interval.start}&end_date=${interval.end}`,
                onload: Toggl.getRetryingFunction(_onSuccess, self.getTsr, [interval, onSuccess]),
                onerror: console.error
            },
        );
    };

    getProject(projectId, onSuccess) {
        //TODO should cache this
        let _onSuccess = (typeof onSuccess === 'undefined') ? console.info : onSuccess;
        console.info(`Fetching project with ID ${projectId} from Toggl.`);
        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                },
                url: `https://www.toggl.com/api/v8/projects/${projectId}`,
                onload: Toggl.getRetryingFunction(_onSuccess, this.getProject.bind(this), [projectId, onSuccess]),
                onerror: console.error
            },
        );
    };

    roundTimeEntry(timeEntry) {
        let start = new Date(timeEntry.start);
        let end = new Date(timeEntry.end);
        DateUtils.roundDate(start);
        DateUtils.roundDate(end);

        let dtoIn = {};
        dtoIn.time_entry = {};
        dtoIn.time_entry.start = start;
        dtoIn.time_entry.stop = end;
        dtoIn.time_entry.duration = DateUtils.getDurationSec(start, end);
        const requestData = JSON.stringify(dtoIn);
        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                data: requestData,
                url: `https://www.toggl.com/api/v8/time_entries/${timeEntry.id}`,
                onload: Toggl.getRetryingFunction(console.info, this.roundTimeEntry.bind(this), [timeEntry]),
                onerror: console.error
            }
        );
    };

    static getRetryingFunction(originalHandler, calledFunction, params) {
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
        console.info(response);
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
        this.end = togglTimeEntry.stop;
        this.duration = togglTimeEntry.duration;
        this.description = togglTimeEntry.description.trim();
        if (togglProject) {
            this.project = togglProject.name.trim();
        }
        if (togglTimeEntry.tags && togglTimeEntry.tags.length > 0) {
            this.category = togglTimeEntry.tags[0].trim();
        }
    }

}

(function () {
    'use strict';

    const plus4uWtm = new Plus4uWtm();
    const toggl = new Toggl();
    const jira = new Jira4U();

    let initPage = function () {
        console.info("Initializing Toggl2plus4u extension.");

        if (!isPageReady()) {
            setTimeout(initPage, 1000);
            return;
        }

        addToolbar();
    };

    let isPageReady = function () {
        let page = $(".right-pane-inner");
        return page.length;
    };

    let addToolbar = function () {
        console.info("Adding toolbar to the page.");

        const thisWeek = DateUtils.getThisWeek();
        const inputPanel = `<div class="inputPanel">
                <div><label for="uniExtFrom">From:</label><input type="date" id="uniExtFrom" value=${DateUtils.toHtmlFormat(thisWeek.start)} /></div><div><label for="uniExtTo">To:</label><input type="date" id="uniExtTo" value=${DateUtils.toHtmlFormat(thisWeek.end)} /></div><div id="uniExtToSummary"></div></div>`;
        const buttons = `<div class="buttonsPanel"><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button></div>`;
        const toolbar = `<div id="uniExtToolbar">${inputPanel} ${buttons}</div>`;
        $(".right-pane-inner .react-viewport-container").prepend(toolbar);

        document.getElementById("uniExtBtnRound").addEventListener("click", roundTsrReport, false);
        document.getElementById("uniExtBtnReport").addEventListener("click", reportWork, false);
        document.getElementById("uniExtFrom").addEventListener("change", printReportSummary, false);
        document.getElementById("uniExtTo").addEventListener("change", printReportSummary, false);
        console.info("Toolbar init finished");
        printReportSummary();
    };

    let printReportSummary = function () {
        toggl.getTsr(getInterval(), function (resp) {
            let timeEntries = JSON.parse(resp.responseText);
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
            $("#uniExtToSummary").html(`<div><strong>${Math.round(sum / 60 / 60 * 100) / 100} </strong> hours will be rounded to <strong>${Math.round(roundedSum / 60 / 60 * 100) / 100} </strong> hours</div>`);
        });
    };

    let reportWork = function () {
        let interval = getInterval();
        toggl.loadTsr(interval, logWorkToPlus4U);
    };

    let logWorkToPlus4U = function (timeEntry) {
        plus4uWtm.logWorkItem(timeEntry, new ResponseCallback(function () {
            logWorkToJira(timeEntry)
        }));
    };

    let logWorkToJira = function (timeEntry) {
        jira.logWork(timeEntry);
    };

    let roundTsrReport = function () {
        let interval = getInterval();
        toggl.loadTsr(interval, toggl.roundTimeEntry.bind(toggl));
    };

    let getInterval = function () {
        let start = DateUtils.toStartDate(document.querySelector("#uniExtFrom").value).toISOString();
        let end = DateUtils.toEndDate(document.querySelector("#uniExtTo").value).toISOString();
        return {start, end};
    };

    initPage();
})();

