# Integration from Toggl to Plus4U and Jira


# Install as a User Script - Tampermonkey
1. Add https://tampermonkey.net/ into your browser
1. Install User script from this URL: [toggl2plus4u.user.js](https://raw.githubusercontent.com/jiri-neuman/toggl2plus4u/master/toggl2plus4u.user.js)

# Reporting to Plus4U
1. Open the [https://toggl.com/app/timer](Timer) page in Toggl.
1. Adjust the date interval for which you want to report your work.
    * Before reporting, the times should be rounded to whole 15 minutes. In the toolbar, you can see the sum of the work for your selected interval and next to it
    , sum of work after rounding for review.
1. Round the times and report by using buttons in the toolbar.   


# Reporting to Jira
1. Work will be also reported to JIRA if the description of the work log contains JIRA ticket in the beginning. 
The ticket must be separated by space from the following description (e.g. FCC-200 Workspace setup).
1. Report will be sent to Jira only if it is successfully reported to Plus4U.
    * The script relies on Plus4U behavior, which returns error for overlapping work logs. This way, it is ensured that no work is logged more than once.    

# Errors, messages
Currently there is no gui feedback - all messages and errors are logged only to the javascript console.  


