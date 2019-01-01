// ==UserScript==
// @name         Clockify integration with Plus4U and Jira
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Integrates Clockify with Plus4U Work Time Management and Jira
// @author       Jiri Neuman
// @match        https://clockify.me/tracker
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @require      http://code.jquery.com/jquery-2.1.4.min.js
// @require      https://code.jquery.com/ui/1.12.1/jquery-ui.js
// ==/UserScript==

class Plus4uWtm {

    constructor() {
        this.token = null;
        this.wtmUrl = "https://uuos9.plus4u.net/uu-specialistwtmg01-main/99923616732453117-8031926f783d4aaba733af73c1974840";
        this._fetchToken();
    }

    logWorkItem(timeEntry) {
        let dtoIn = {};
        dtoIn.datetimeFrom = new Date(timeEntry.timeInterval.start).toISOString();
        dtoIn.datetimeTo = new Date(timeEntry.timeInterval.end).toISOString();
        dtoIn.subject = `ues:${timeEntry.project.name}`;
        if(timeEntry.tags !== null && timeEntry.tags.length > 0) {
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
                onload: console.info,
                onerror: console.error
            },
        );
    }

    getTsr() {
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
                onload: console.info,
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
                    "X-Api-Key":  this.API_KEY
                },
                url: "https://api.clockify.me/api/workspaces/5bdffdc4b0798754befdf3a0/timeEntries/user/5bdffdc4b0798754befdf39f/entriesInRange",
                data: requestData,
                onload: _onSuccess,
                onerror: console.error
            },
        );
    };

    //TODO add to button
    roundTimes(e) {
        console.info(e);
        let timeEntries = JSON.parse(e.responseText);
        timeEntries.timeEntriesList.forEach(this.roundTimeEntry.bind(this));
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

    let isPageReady = function() {
        let page = $(".paginator");
        return page.length;
    };

    let addToolbar = function () {
        console.info("Adding toolbar to the page.");

        const currentDate = DateUtils.getCurrentDate();
        const intervalSelection = `<input type="date" id="uniExtFrom" value=${currentDate} /><input type="date" id="uniExtTo" value=${currentDate} />`;
        const clockifyKeyInput = `<input type="password" id="uniExtClockifyKey" />`;
        const buttons = `<button id="uniExtBtnApply">Apply</button><button id="uniExtBtnRound">Round times</button><button id="uniExtBtnReport">Report</button>`;
        const toolbar = `<div>${clockifyKeyInput} ${intervalSelection} ${buttons}</div>`;
        $("body").prepend(toolbar);

        document.getElementById("uniExtBtnRound").addEventListener("click",
            printTsrReport, false);
        document.getElementById("uniExtBtnApply").addEventListener("click",
            getInterval, false);
        document.getElementById("uniExtBtnReport").addEventListener("click",
            reportWorkToPlus4u, false);
        console.info("Toolbar init finished");
    };

    let reportWorkToPlus4u = function () {
        let interval = getInterval();
        getClockify().getTsrClockify(interval, logWork);
    };

    let logWork = function (e) {
        let timeEntries = JSON.parse(e.responseText);
        console.debug(timeEntries);
        console.info(`Reporting ${timeEntries.length} entries to Plus4U.`);
        timeEntries.forEach(plus4uWtm.logWorkItem.bind(plus4uWtm));
    };

    let printTsrReport = function () {
        let interval = getInterval();
        getClockify().getTsrClockify(interval, console.info);
    };

    let getInterval = function () {
        let start = DateUtils.toStartDate(document.querySelector("#uniExtFrom").value).toISOString();
        let end = DateUtils.toEndDate(document.querySelector("#uniExtTo").value).toISOString();
        return {start, end};
    };

    let getClockify = function() {
        const clockifyKey = document.querySelector("#uniExtClockifyKey").value;
        return new Clockify(clockifyKey);
    };

    initPage();
})();

