// ==UserScript==
// @name         Clockify integration with Plus4U and Jira
// @namespace    https://github.com/jiri-neuman/clockify2plus4u
// @version      0.1
// @description  Integrates Clockify with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://clockify.me/tracker
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @require      http://code.jquery.com/jquery-2.1.4.min.js
// @require      https://code.jquery.com/ui/1.12.1/jquery-ui.js
// ==/UserScript==

GM_addStyle(`
    #uniExtToolbar {
        margin: 5px 0 5px 0;
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
    }
`);

class Plus4uWtm {

    constructor() {
        this.token = null;
        this.wtmUrl = "https://uuos9.plus4u.net/uu-specialistwtmg01-main/99923616732453117-8031926f783d4aaba733af73c1974840";
        this._fetchToken();
    }

    logWorkItem(timeEntry, responseCallback = new ResponseCallback()) {
        let dtoIn = {};
        dtoIn.datetimeFrom = new Date(timeEntry.timeInterval.start).toISOString();
        dtoIn.datetimeTo = new Date(timeEntry.timeInterval.end).toISOString();
        dtoIn.subject = `ues:${timeEntry.project.name}`;
        if (timeEntry.tags !== null && timeEntry.tags.length > 0) {
            dtoIn.category = timeEntry.tags[0].name;
        }
        dtoIn.description = timeEntry.description;

        const requestData = JSON.stringify(dtoIn);
        console.debug(requestData);

        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.token}`,
                    "Origin": "https://uuos9.plus4u.net",
                    "Referer": `${this.wtmUrl}`,
                },
                data: requestData,
                url: `${this.wtmUrl}/createTimesheetItem`,
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
                    "Authorization": `Bearer ${this.token}`,
                    "Origin": "https://uuos9.plus4u.net",
                    "Referer": `${this.wtmUrl}`
                },
                data: `{"yearMonth":"201812"}`,
                url: `${this.wtmUrl}/listWorkerTimesheetItemsByMonth`,
                onload: responseCallback.onResponse.bind(responseCallback),
                onerror: console.error
            }
        );
    }

    _fetchToken() {
        console.log(`Fetching Plus4U authentication token.`);
        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: 'GET',
                headers: {
                    "Origin": "https://uuos9.plus4u.net",
                },
                url: "https://oidc.plus4u.net/uu-oidcg01-main/99923616732452117-4f06dafc03cb4c7f8c155aa53f0e86be/oauth2?scope=openid&response_type=id_token&prompt=none&redirect_uri=https%3A%2F%2Fplus4u.net%2Fues%2Foauth-login-callback",
                onload: this._saveToken.bind(this),
                onerror: console.error
            }
        );
    }

    _saveToken(e) {
        let url = new URL(e.finalUrl.replace("#", "?"));
        this.token = url.searchParams.get("id_token");
        console.info("Token obtained.");
    }

}


/**
 * JIRA API connector.
 */
class Jira4U {

    constructor() {
        console.info("Initializing JIRA");
        this.jiraUrl = 'https://jira.unicorn.eu';
        this.jiraBrowseIssue = this.jiraUrl + "/browse";
        this.jiraRestApiUrl = this.jiraUrl + '/rest/api/2';
        this.jiraRestApiUrlIssue = this.jiraRestApiUrl + '/issue';
        this.jiraIssueKeyPattern = /([A-Z]+-\d+)/;
        console.info("JIRA initialized");
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

    logWork(timeEntry, responseCallback = new ResponseCallback(), onerror = console.error, onprogress = console.info) {
        let workDescription = WorkDescription.parse(timeEntry.description);
        if(!workDescription.issueKey) {
            console.info("Time entry not bound to JIRA issue.");
            return;
        }
        const startTime = new Date(timeEntry.timeInterval.start);
        const endTime = new Date(timeEntry.timeInterval.end);
        let dtoIn = {};
        dtoIn.comment = workDescription.descriptionText;
        dtoIn.started = this.toIsoString(startTime);
        dtoIn.timeSpentSeconds = (endTime - startTime) / 1000;
        let requestData = JSON.stringify(dtoIn);
        console.log(`Sending a work log request to ${workDescription.issueKey}. ${requestData}`);
        // let started = this.toIsoString(workInfo.started);
        // console.log(`Started at: ${started}`);
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
        this._issueKey = issueKey;
        this._descriptionText = descriptionText;
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

    get issueKey() {
        return this._issueKey;
    }

    get descriptionText() {
        return this._descriptionText;
    }
}

class Clockify {

    constructor(apiKey) {
        //TODO think if this can be solved differently
        this.API_KEY = apiKey;
    }

    getTsrClockify(interval, onSuccess) {
        let _onSuccess = (typeof onSuccess === 'undefined') ? console.info : onSuccess;
        console.info(`Fetching TSR from Clockify.`);

        const requestData = JSON.stringify(interval);
        console.debug(requestData);

        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": this.API_KEY
                },
                url: "https://api.clockify.me/api/workspaces/5bdffdc4b0798754befdf3a0/timeEntries/user/5bdffdc4b0798754befdf39f/entriesInRange",
                data: requestData,
                onload: _onSuccess,
                onerror: console.error
            },
        );
    };

    roundTimes(e) {
        console.info("Rounding time entries.");
        console.debug(e);
        let timeEntries = JSON.parse(e.responseText);
        timeEntries.forEach(this.roundTimeEntry.bind(this));
    }

    roundTimeEntry(timeEntry) {
        let start = new Date(timeEntry.timeInterval.start);
        let end = new Date(timeEntry.timeInterval.end);
        this.roundDate(start);
        this.roundDate(end);

        let dtoIn = {...timeEntry};
        dtoIn.start = start;
        dtoIn.end = end;
        const requestData = JSON.stringify(dtoIn);

        // noinspection JSUnresolvedFunction
        GM_xmlhttpRequest(
            {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": this.API_KEY
                },
                data: requestData,
                url: `https://api.clockify.me/api/workspaces/${timeEntry.workspaceId}/timeEntries/${timeEntry.id}`,
                onload: console.info,
                onerror: console.error
            }
        );
    };

    roundDate(dateTime) {
        dateTime.setMilliseconds(0);
        dateTime.setSeconds(0);
        dateTime.setMinutes(Math.round(dateTime.getMinutes() / 15) * 15);
    };

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

    static getCurrentDate() {
        let currentDate = new Date();
        return currentDate.getFullYear() + "-" + DateUtils.pad2(currentDate.getMonth() + 1) + "-" + DateUtils.pad2(currentDate.getDate());
    };

    static pad2(number) {
        return (number < 10 ? '0' : '') + number;
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

(function () {
    'use strict';

    const plus4uWtm = new Plus4uWtm();

    let initPage = function () {
        console.info("Initializing Clockify2plus4u extension.");

        if (!isPageReady()) {
            setTimeout(initPage, 1000);
            return;
        }

        addToolbar();
    };

    let isPageReady = function () {
        let page = $(".paginator");
        return page.length;
    };

    let addToolbar = function () {
        console.info("Adding toolbar to the page.");

        const currentDate = DateUtils.getCurrentDate();
        const inputPanel = `<div class="inputPanel"><div><label for="uniExtClockifyKey">Clockify Key:</label><input type="password" id="uniExtClockifyKey" name="password" /></div>
                <div><label for="uniExtFrom">From:</label><input type="date" id="uniExtFrom" value=${currentDate} /></div><div><label for="uniExtTo">To:</label><input type="date" id="uniExtTo" value=${currentDate} /></div></div>`;
        const buttons = `<div class="buttonsPanel"><button id="uniExtBtnApply">Apply</button><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button></div>`;
        const toolbar = `<div id="uniExtToolbar">${inputPanel} ${buttons}</div>`;
        $("body").prepend(toolbar);

        document.getElementById("uniExtBtnRound").addEventListener("click",
            roundTsrReport, false);
        document.getElementById("uniExtBtnApply").addEventListener("click",
            printTsrReport, false);
        document.getElementById("uniExtBtnReport").addEventListener("click",
            reportWork, false);
        console.info("Toolbar init finished");
    };

    let reportWork = function () {
        let interval = getInterval();
        getClockify().getTsrClockify(interval, logWork);
    };

    let logWork = function (e) {
        let timeEntries = JSON.parse(e.responseText);
        console.info(`Reporting ${timeEntries.length} entries to Plus4U.`);
        timeEntries.forEach(logWorkToPlus4U);
    };

    let logWorkToPlus4U = function (timeEntry) {
        plus4uWtm.logWorkItem(timeEntry, new ResponseCallback(function(){logWorkToJira(timeEntry)}));
    };

    let logWorkToJira = function (timeEntry) {
        new Jira4U().logWork(timeEntry);
    };

    let printTsrReport = function () {
        let interval = getInterval();
        new Jira4U().loadIssue("FBLI-3000", new ResponseCallback(), console.error, console.debug);
        getClockify().getTsrClockify(interval, console.info);
    };

    let roundTsrReport = function () {
        let interval = getInterval();
        let clockify = getClockify();
        clockify.getTsrClockify(interval, clockify.roundTimes.bind(clockify));
    };

    let getInterval = function () {
        let start = DateUtils.toStartDate(document.querySelector("#uniExtFrom").value).toISOString();
        let end = DateUtils.toEndDate(document.querySelector("#uniExtTo").value).toISOString();
        return {start, end};
    };

    let getClockify = function () {
        const clockifyKey = document.querySelector("#uniExtClockifyKey").value;
        return new Clockify(clockifyKey);
    };

    initPage();
})();

